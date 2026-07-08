import type { CircuitBreaker } from "@everdict/backends";
import type { AgentJob } from "@everdict/core";
import type { SpilloverOutcome } from "./runtime-spillover.js";

// Tail speculation — straggler mitigation for sharded batches (docs/architecture/batch-resilience.md).
//
// Spillover reacts to FAILURE; this reacts to SLOWNESS. Static round-robin sharding means a slow-but-alive
// runtime holds its share while the rest of the pool idles at the batch tail. Once every case has been
// dispatched (pure tail — speculating earlier would steal capacity from undispatched work), a case in flight
// longer than `medianFactor × median completed duration` (floored at `minStragglerMs`) gets a DUPLICATE
// dispatch on another healthy runtime of the same user-selected shard list; the first result wins and the
// loser is discarded (bounded double compute, tail only). One duplicate per case, never onto an open circuit,
// and single-runtime batches are untouched (nowhere to speculate onto).
export interface SpeculationOpts {
  targets: string[]; // the shard list — speculation candidates (<=1 → controller is inert)
  tenant: string;
  breaker: CircuitBreaker; // skip open circuits when picking the duplicate's runtime
  totalCases: number; // dispatched-vs-total defines the tail
  minStragglerMs?: number; // floor before anything counts as a straggler (default 10s)
  medianFactor?: number; // straggler = elapsed > factor × median completed duration (default 2)
  rearmMs?: number; // poll floor when the check fires but conditions aren't met yet (default 1s)
  now?: () => number;
  // Injectable timer (tests) — returns a cancel fn.
  setTimer?: (fn: () => void, ms: number) => () => void;
  onSpeculate?: (caseId: string, from: string, to: string) => void;
  onWin?: (caseId: string, winner: string, speculated: boolean) => void;
  // Reclaim hook — when a speculated case settles, cancel any of its dispatches still QUEUED at the scheduler
  // (the loser may never have reached a backend; there is no reason to let it).
  cancelQueued?: (caseId: string) => void;
}

const DEFAULT_MIN_STRAGGLER_MS = 10_000;
const DEFAULT_REARM_MS = 1_000;

export class SpeculationController {
  private readonly durations: number[] = [];
  private started = 0;
  private readonly clock: () => number;
  private readonly timer: (fn: () => void, ms: number) => () => void;

  constructor(private readonly opts: SpeculationOpts) {
    this.clock = opts.now ?? (() => Date.now());
    this.timer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  // Straggler threshold — needs at least one completed sibling (no basis before that).
  private thresholdMs(): number | undefined {
    if (this.durations.length === 0) return undefined;
    const sorted = [...this.durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    return Math.max(this.opts.minStragglerMs ?? DEFAULT_MIN_STRAGGLER_MS, (this.opts.medianFactor ?? 2) * median);
  }

  private duplicateTarget(assigned: string | undefined): string | undefined {
    if (this.opts.targets.length <= 1) return undefined;
    return this.opts.targets.find((t) => t !== assigned && !this.opts.breaker.isOpen(`${this.opts.tenant}:${t}`));
  }

  // Wrap one case execution. `execute` is the (spillover-wrapped) executor; the duplicate reuses it with the
  // placement rewritten, so it gets the same failover semantics as any dispatch.
  run(execute: (job: AgentJob) => Promise<SpilloverOutcome>, job: AgentJob): Promise<SpilloverOutcome> {
    this.started += 1;
    const startedAt = this.clock();
    const assigned = job.evalCase.placement?.target;
    let cancelTimer: (() => void) | undefined;
    let speculated = false;

    return new Promise<SpilloverOutcome>((resolve, reject) => {
      // Dynamic first-success race: the duplicate may join after the primary is already pending.
      let pending = 0;
      let settled = false;
      let firstError: unknown;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cancelTimer?.();
        fn();
      };
      const join = (p: Promise<SpilloverOutcome>): void => {
        pending += 1;
        p.then(
          (v) => {
            const elapsed = this.clock() - startedAt;
            finish(() => {
              this.durations.push(elapsed);
              this.opts.onWin?.(job.evalCase.id, v.target ?? assigned ?? "", speculated);
              if (speculated) this.opts.cancelQueued?.(job.evalCase.id); // the loser may still be queued — reclaim it
              resolve(v);
            });
          },
          (e) => {
            if (firstError === undefined) firstError = e;
            pending -= 1;
            if (pending === 0) finish(() => reject(firstError));
          },
        );
      };

      const arm = (waitMs: number): void => {
        cancelTimer = this.timer(() => {
          if (settled || speculated) return;
          const rearm = this.opts.rearmMs ?? DEFAULT_REARM_MS;
          // Pure tail only — every case dispatched. Not there yet → poll again.
          if (this.started < this.opts.totalCases) {
            arm(rearm);
            return;
          }
          // No completed sibling yet (e.g. the tail's lone straggler) → the floor IS the threshold.
          const threshold = this.thresholdMs() ?? this.opts.minStragglerMs ?? DEFAULT_MIN_STRAGGLER_MS;
          const elapsed = this.clock() - startedAt;
          if (elapsed < threshold) {
            arm(Math.max(rearm, threshold - elapsed));
            return;
          }
          const target = this.duplicateTarget(assigned);
          if (target === undefined) return; // no healthy alternative — let the primary finish
          speculated = true;
          this.opts.onSpeculate?.(job.evalCase.id, assigned ?? "", target);
          join(
            execute({
              ...job,
              evalCase: { ...job.evalCase, placement: { ...job.evalCase.placement, target } },
            }),
          );
        }, waitMs);
      };

      join(execute(job));
      if (this.duplicateTarget(assigned) !== undefined) {
        arm(this.thresholdMs() ?? this.opts.minStragglerMs ?? DEFAULT_MIN_STRAGGLER_MS);
      }
    });
  }
}
