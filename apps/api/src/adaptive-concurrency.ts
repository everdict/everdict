// Adaptive batch concurrency (docs/architecture/batch-resilience.md). A batch's configured concurrency is a
// FIXED worker count in runSuite — when a runtime circuit opens or the scheduler queue spikes, full-width
// fan-out just piles work onto a struggling system (spillover churn, queue floods). This gate sits inside the
// batch's dispatch closure and shrinks the EFFECTIVE parallelism under pressure, then restores it by itself:
// the pressure factor is re-sampled at every acquire/release, so no timer and no explicit reset path.
//
// Semantics: effective = max(1, round(base × factor())), factor ∈ [0,1]. Shrinking never cancels in-flight
// work (excess dispatches finish naturally and are simply not replaced); the floor of 1 keeps a trickle probe
// running so recovery is observed without a dedicated health check.
export interface AdaptiveConcurrencyOpts {
  base: number; // the batch's configured concurrency (runSuite worker count = the hard ceiling)
  factor?: () => number; // pressure multiplier, sampled on every acquire/release. Absent = always 1 (inert gate).
  onChange?: (effective: number, previous: number) => void; // observability — fired on effective-width transitions
}

export class AdaptiveConcurrencyGate {
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private lastEffective: number;

  constructor(private readonly opts: AdaptiveConcurrencyOpts) {
    // Transitions are reported relative to the configured base — a batch that STARTS under pressure still
    // surfaces its first `base → shrunken` transition instead of being silently born narrow.
    this.lastEffective = opts.base;
  }

  effective(): number {
    const raw = this.opts.factor?.() ?? 1;
    const factor = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
    return Math.max(1, Math.round(this.opts.base * factor));
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.inFlight >= this.sample()) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      // Wake everyone — each waiter re-checks the (freshly sampled) width and re-parks if there's still no room.
      // Waiter counts are batch-concurrency sized, so the thundering herd is bounded and the code stays obviously correct.
      const woken = this.waiters;
      this.waiters = [];
      for (const wake of woken) wake();
    }
  }

  private sample(): number {
    const effective = this.effective();
    if (effective !== this.lastEffective) {
      const previous = this.lastEffective;
      this.lastEffective = effective;
      this.opts.onChange?.(effective, previous);
    }
    return effective;
  }
}
