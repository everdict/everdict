import type { AttemptRef, CaseJob, CaseResult, RuntimeWorkRef } from "@everdict/contracts";
import { type CircuitBreaker, type HarnessSecretMaps, resolveHarnessSecrets } from "@everdict/domain";
import { executeCase } from "../execution/execute-case.js";
import { type PhysicalAttempt, jobAttemptId, openPhysicalAttempt } from "../execution/open-physical-attempt.js";
import { executeWithOomBoost } from "../ops/oom-boost.js";
import { executeWithSpillover } from "../ops/runtime-spillover.js";
import type { SpeculationController } from "../ops/speculation.js";
import type { CaseOutcomeCommitter } from "./case-outcome-committer.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";

// ── HOW ONE CASE PHYSICALLY RUNS, FOR BOTH DRIVERS ───────────────────────────────────────────────────
//
// The resilience machinery a single case goes through (spillover across the shard list · in-batch OOM
// boost · tail speculation) and the attempt each of those re-dispatches opens. It is a collaborator rather
// than a method on either driver because BOTH drive cases through it — the in-process track loop and the
// Temporal per-case activity — and the two used to mirror this block "by construction", which is the
// duplication every review since has found a defect in.

export class ResilientCaseRunner {
  constructor(
    private readonly deps: ScorecardBatchDeps,
    private readonly breaker: CircuitBreaker,
    private readonly commit: CaseOutcomeCommitter,
  ) {}

  // ── A NEW PHYSICAL EXECUTION OPENS ITS OWN ATTEMPT (review 40 follow-up) ───────────────────────────
  //
  // Spillover, the OOM boost and the speculation duplicate all re-dispatch the SAME job, and all of them
  // used to ride the recording generation the first dispatch opened — so `attemptIdOf(executionId, gen)`
  // named a physical attempt only when nothing interesting happened. Two executions of one case (the
  // straggler AND its duplicate, racing concurrently) wrote into one evidence buffer, and the winner's
  // replay could carry the loser's frames. Every internal re-dispatch now opens its own generation; the
  // WINNER's job (SpilloverOutcome.job) is what the finalizer seals, claims and references. An open that
  // fails STRIPS the stale number instead of inheriting it — writing into another physical execution's
  // buffer is the one thing this exists to prevent, so those producers land in the unclaimed g0 bucket.
  // `cx` is the DRIVER's coordinate, not the job's: CaseJob.tenant is optional and the ledger's tenant is not
  // a value to default — every caller of this already holds the batch's own.
  reattemptOf(cx: {
    tenant: string;
    scorecardId: string;
    driverEpoch?: number;
    // ── DOES THE ATTEMPT THIS ONE REPLACES STOP HERE? (arch-review 51) ────────────────────────────────
    //
    // A spill, an OOM boost and a control-plane retry all re-dispatch because the previous physical
    // execution is DEAD — it failed, or the kernel killed it — so its row is superseded the moment the
    // successor opens, which is the only moment anybody knows it. A speculation duplicate is not that: the
    // two run CONCURRENTLY and the race decides which one is the answer, so superseding at open time would
    // terminalize an execution that is still producing (its own loser stamp is made at the race's end).
    concurrent?: boolean;
    // Told about every attempt this opens, so the lane's own bookkeeping can follow the CURRENT physical
    // execution instead of the one its dispatch opened. Without it, a case that spilled and then failed
    // recorded the FIRST attempt as the failed one — a row already superseded, so the stamp was refused and
    // the attempt that actually failed stayed non-terminal. Per-batch by construction: the closure the caller
    // passes owns the state (arch-review 34 — never an instance field).
    onOpen?: (executionId: string, opened: PhysicalAttempt) => void;
  }): ((job: CaseJob) => Promise<CaseJob>) | undefined {
    const store = this.deps.recordingStore;
    // A deployment with the attempt LEDGER and no recording store still has physical attempts, and they are
    // exactly the ones this opens (arch-review 51): re-dispatches used to open nothing at all there, so a
    // spill/boost/duplicate left no row while the dispatch lanes beside it were writing theirs.
    if (!store && !this.deps.attempts) return undefined;
    return async (job: CaseJob): Promise<CaseJob> => {
      const executionId = job.runId;
      if (!executionId) return job;
      // …and each of these re-dispatches is a PHYSICAL EXECUTION with its own ledger row (arch-review 42).
      // These are precisely the attempts that used to leave no trace: a spillover duplicate or a speculation
      // loser spends full compute and, unless it happened to record something, was invisible afterwards.
      const opened = await openPhysicalAttempt(
        { attempts: this.deps.attempts, recordings: store },
        {
          executionId,
          tenant: cx.tenant,
          scorecardId: cx.scorecardId,
          caseId: job.evalCase.id,
          ...(job.trial !== undefined ? { trial: job.trial } : {}),
          ...(cx.driverEpoch !== undefined ? { driverEpoch: cx.driverEpoch } : {}),
        },
      );
      cx.onOpen?.(executionId, opened);
      // …and the attempt it REPLACES reaches its terminal state here (arch-review 51). Only the abandoning
      // re-dispatches (see `concurrent`) — and only best-effort, the posture every stamp with no transaction
      // to ride keeps: an abandoned attempt commits nothing, so nothing reads this to decide anything.
      if (!cx.concurrent) {
        const replaced = jobAttemptId(job, executionId);
        if (replaced !== undefined && replaced !== opened.attemptId)
          await this.commit.stampAttempt(replaced, "superseded", {
            error: { code: "ATTEMPT_SUPERSEDED", message: "re-dispatched as a new physical attempt" },
          });
      }
      // BOTH HALVES OF THE COORDINATE MOVE (arch-review 51). Stamping only the generation left the job naming
      // the attempt it just replaced — and when the recording claim was refused it named it with nothing at
      // all, so this execution's row (which exists, marked unisolated) could never be addressed again.
      const { recordingGeneration: _stale, attemptId: _replacedName, ...rest } = job;
      return {
        ...rest,
        ...(opened.generation !== undefined ? { recordingGeneration: opened.generation } : {}),
        ...(opened.attemptId !== undefined ? { attemptId: opened.attemptId } : {}),
      };
    };
  }

  // Run ONE case through the full resilience machinery — spillover across the shard list (the shared breaker skips
  // known-outage runtimes) + in-batch OOM auto-boost + tail speculation — returning the result and the runtime that
  // ACTUALLY ran it. Shared by BOTH batch drivers: the in-process `track` loop and the Temporal per-case activity
  // `runBatchCase`, which previously mirrored this ~40-line block "by construction". The site-specific concerns (how a
  // step is appended, whether a child run flips to running) are injected callbacks; the common orchestration events
  // (spillover / oom_escalated) fire here so both drivers report them identically.
  run(
    job: CaseJob,
    cfg: {
      owner: string; // executeCase requires it (private-repo token resolution); both drivers have a defined owner
      targets: string[];
      tenant: string;
      secretMap?: HarnessSecretMaps;
      boostMb?: number;
      oomAutoBoost?: boolean;
      speculation?: SpeculationController;
      onWaiting: (reason: string) => void;
      // Fired when compute ACTUALLY starts, per physical dispatch — handed the job that started, because a
      // spill/OOM reattempt inside this call dispatches a DIFFERENT attempt than the one the caller opened,
      // and an executing-stamp keyed to the dispatch-time capture named the abandoned row (arch-review 51
      // residue). The started job's own coordinates are the attempt that reached the machine.
      onStarted?: (startedJob: CaseJob) => void;
      // Fired when a placement backend CREATES external work for this case — the exact handle to the job it
      // just applied/submitted (arch-review 52, Wave 2). Forwarded verbatim: the handle carries the attempt
      // id off the dispatched job, so the caller stamps it without re-deriving which attempt this dispatch
      // was — which matters here, where spillover and speculation dispatch several.
      onReserved?: (work: RuntimeWorkRef) => Promise<void> | void;
      onStep: (message: string, caseId: string) => void;
      // Opens a fresh recording attempt for a NEW physical execution (spill / OOM boost / speculation
      // duplicate) and returns the job stamped with it — see SpilloverOpts.reattempt.
      reattempt?: (job: CaseJob) => Promise<CaseJob>;
    },
  ): Promise<{ result: CaseResult; target?: string; job: CaseJob }> {
    // Resolve env secret references just before dispatch; a missing referenced secret throws → the case is isolated.
    const resolved =
      cfg.secretMap && job.harnessSpec
        ? { ...job, harnessSpec: resolveHarnessSecrets(job.harnessSpec, cfg.secretMap) }
        : job;
    // OOM escalation — a boosted retry re-runs a memory-killed case with the higher memoryMb on the job only.
    const jobToRun =
      cfg.boostMb !== undefined && resolved.harnessSpec?.kind === "command"
        ? {
            ...resolved,
            harnessSpec: {
              ...resolved.harnessSpec,
              resources: { ...resolved.harnessSpec.resources, memoryMb: cfg.boostMb },
            },
          }
        : resolved;
    // The attempt a self-hosted RE-LEASE actually ran under (arch-review 41 P0-evidence): the hub mints a
    // fresh attempt at the second lease and reports it via onAttempt — the job the control plane dispatched
    // still carries the first one. Keyed BY THE DISPATCHED JOB, not a shared slot: speculation runs two
    // branches concurrently, and a shared capture would attribute the last lease to whichever branch happened
    // to win. The value is the whole REF (arch-review 52): with only a generation, a re-lease whose recording
    // claim was refused reported nothing and this map stayed empty for the one case it exists to catch.
    const attemptByJob = new Map<CaseJob, AttemptRef>();
    // Spillover wraps executeCase; tail speculation wraps that (a straggler gets a duplicate, first result wins).
    const exec = (j: CaseJob): Promise<{ result: CaseResult; target?: string; job: CaseJob }> =>
      executeWithSpillover(
        (jj) =>
          executeCase(this.deps, cfg.owner, jj, {
            onWaiting: cfg.onWaiting,
            // The dispatched job rides into the hook — `jj` is THIS physical dispatch's job (a reattempt
            // rebuilt it), so the caller's executing-stamp names the attempt that actually started.
            ...(cfg.onStarted ? { onStarted: () => cfg.onStarted?.(jj) } : {}),
            onAttempt: (attempt) => attemptByJob.set(jj, attempt),
            ...(cfg.onReserved ? { onReserved: cfg.onReserved } : {}),
          }),
        j,
        {
          targets: cfg.targets,
          tenant: cfg.tenant,
          breaker: this.breaker,
          onSpill: (caseId, from, to, code) => {
            this.deps.onOrchestrationEvent?.({ kind: "spillover", from, to, code });
            cfg.onStep(`${caseId}: runtime spillover ${from} → ${to} (${code})`, caseId);
          },
          ...(cfg.reattempt ? { reattempt: cfg.reattempt } : {}),
        },
      );
    return executeWithOomBoost((j) => (cfg.speculation ? cfg.speculation.run(exec, j) : exec(j)), jobToRun, {
      enabled: cfg.oomAutoBoost ?? false,
      onBoost: (cid, fromMb, toMb) => {
        this.deps.onOrchestrationEvent?.({ kind: "oom_escalated", memoryMb: toMb });
        cfg.onStep(`${cid}: OOM auto-boost ${fromMb} → ${toMb}Mb (in-batch retry)`, cid);
      },
      ...(cfg.reattempt ? { reattempt: cfg.reattempt } : {}),
    }).then((outcome) => {
      // Restamp the WINNER's job with the attempt its own dispatch was leased under. Identity-keyed: never
      // another branch's coordinate. (A single reported attempt with an unmatched winner reference means a
      // wrapper rebuilt the job object on the way back — unambiguous, so it still attributes.)
      const leased =
        attemptByJob.get(outcome.job) ?? (attemptByJob.size === 1 ? [...attemptByJob.values()][0] : undefined);
      if (leased === undefined) return outcome;
      // BOTH HALVES MOVE TOGETHER (arch-review 51 · 52). The name on this job points at the attempt the lease
      // REPLACED, so keeping it would seal, claim and terminalize the abandoned row — and the generation
      // beside it belongs to that same abandoned attempt. The ref states this attempt's own: its name always,
      // its recording fence only if it owns one. An unisolated re-lease therefore ends up NAMED and unfenced,
      // which is exactly what it is — where before it was silently left wearing its predecessor's coordinate.
      const { attemptId: _replaced, recordingGeneration: _stale, ...bare } = outcome.job;
      return {
        ...outcome,
        job: {
          ...bare,
          attemptId: leased.attemptId,
          ...(leased.recording ? { recordingGeneration: leased.recording.generation } : {}),
        },
      };
    });
  }
}
