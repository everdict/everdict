import type { CaseJob, CaseResult } from "@everdict/contracts";
import { type CircuitBreaker, classifyFailure } from "@everdict/domain";

// Runtime spillover — automatic failover inside a sharded batch (docs/architecture/batch-resilience.md).
//
// A sharded batch pins each case to one runtime of the user's list at plan time. Without spillover, a runtime
// dying mid-batch fails its whole shard and a human re-runs it with retry-failed?class=infra. With it, a
// retryable INFRA dispatch failure moves the case to the next healthy runtime in the SAME user-selected list —
// never to a runtime the user didn't choose. The circuit breaker (keyed `tenant:runtimeId`) remembers the
// outage across cases: once open, later cases assigned to the dead runtime skip straight to a healthy one
// instead of re-discovering the failure one timeout at a time.
//
// What does NOT spill: fatal infra (OOM — same resources would die anywhere), config (fix the workspace),
// harness (same input → same crash), and agent FAILs (legitimate results, they never throw). Single-runtime
// batches pass through untouched — there is nowhere to spill to, and the transient retry keeps handling them.
export interface SpilloverOpts {
  targets: string[]; // the batch's shard list (user-selected runtime ids); length <= 1 → pass-through
  tenant: string; // breaker key scope (runtime ids are tenant-scoped)
  breaker: CircuitBreaker;
  onSpill?: (caseId: string, from: string, to: string, code: string) => void; // progress-step visibility
  // ── A RE-DISPATCH IS A NEW PHYSICAL ATTEMPT (review 40 follow-up) ────────────────────────────────
  // Called for every dispatch AFTER the first (a spill onto the next runtime). The caller opens a fresh
  // recording generation and returns the job stamped with it, so two physical executions of one case never
  // share an evidence buffer — the exact mixing `attemptIdOf(executionId, generation)` exists to prevent.
  reattempt?: (job: CaseJob) => Promise<CaseJob>;
}

export interface SpilloverOutcome {
  result: CaseResult;
  target?: string; // the runtime that actually ran the case (undefined on the pass-through path)
  // The JOB that produced the result — the winning physical attempt. Its recordingGeneration is the attempt
  // the finalizer must seal, claim and reference; using the first dispatch's number instead re-labelled a
  // spilled/boosted/speculated execution's evidence as the original attempt's.
  job: CaseJob;
}

export async function executeWithSpillover(
  run: (job: CaseJob) => Promise<CaseResult>,
  job: CaseJob,
  opts: SpilloverOpts,
): Promise<SpilloverOutcome> {
  const assigned = job.evalCase.placement?.target;
  if (!assigned || opts.targets.length <= 1) return { result: await run(job), job };

  const keyOf = (t: string): string => `${opts.tenant}:${t}`;
  // Candidate order: the assigned runtime first (shard stability), then the rest of the list. Open circuits sink
  // to the end rather than disappearing — if EVERY runtime is open we still probe instead of failing untried.
  const ordered = [assigned, ...opts.targets.filter((t) => t !== assigned)];
  const closed = ordered.filter((t) => !opts.breaker.isOpen(keyOf(t)));
  const open = ordered.filter((t) => opts.breaker.isOpen(keyOf(t)));
  const candidates = [...closed, ...open];

  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const target = candidates[i] as string;
    const retargeted: CaseJob =
      target === assigned
        ? job
        : { ...job, evalCase: { ...job.evalCase, placement: { ...job.evalCase.placement, target } } };
    // The first dispatch runs under the attempt its dispatcher opened; every spill is a NEW physical
    // execution and opens its own (see SpilloverOpts.reattempt).
    const attempt: CaseJob = i === 0 ? retargeted : ((await opts.reattempt?.(retargeted)) ?? retargeted);
    try {
      const result = await run(attempt);
      opts.breaker.success(keyOf(target));
      return { result, target, job: attempt };
    } catch (err) {
      const failure = classifyFailure(err, "dispatch");
      // Only an infra failure says anything about the runtime's health — and saturation says even less: a full
      // session pool / scheduler queue (RATE_LIMITED, 429) means the runtime is BUSY, not down. Feeding it to
      // the breaker opened the circuit on a healthy runtime exactly when a batch ran widest, and the outage
      // fact/notification blamed an outage that never happened. Backpressure still SPILLS below (the next
      // runtime in the user's list may have room); it just never counts toward an outage. (The closed→open
      // transition itself is announced by the breaker's own onOpen hook — wired where the breaker is constructed.)
      if (failure.class === "infra" && failure.code !== "RATE_LIMITED") opts.breaker.failure(keyOf(target));
      lastErr = err;
      const next = candidates[i + 1];
      // Fatal or non-infra failures rethrow immediately: moving runtimes can't fix an OOM-sized harness, a
      // missing secret, or a broken setup line.
      if (!failure.retryable || failure.class !== "infra" || next === undefined) throw err;
      opts.onSpill?.(job.evalCase.id, target, next, failure.code);
    }
  }
  throw lastErr; // unreachable (the loop always returns or throws), but keeps control flow explicit
}
