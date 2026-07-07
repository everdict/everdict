// A queue-depth-based autoscaler: reads the scheduler's load (queued + in-flight) to grow and shrink capacity.
// If capacity-aware placement "queues when there's no room", the autoscaler reads that backlog and "adds room".
// The actuation is abstracted by ScalingTarget — in-memory slots / Nomad Autoscaler / cloud ASG / K8s replica patch.

export interface LoadSignal {
  queued: number; // number of queued jobs
  inFlight: number; // number of in-flight jobs
}

export interface AutoscalePolicy {
  min: number; // minimum capacity (0 = allow scale-to-zero)
  max: number; // maximum capacity (the real infra ceiling)
  // load→target capacity (slots). Default: demand = inFlight + queued (to absorb all waiting).
  targetSlots?: (load: LoadSignal, current: number) => number;
  scaleDownAfterTicks?: number; // downscale hysteresis (anti-flapping). Default 3
}

// Scale target — abstracts the actual capacity-adjustment mechanism.
export interface ScalingTarget {
  readonly id: string;
  current(): number | Promise<number>;
  scaleTo(desired: number): void | Promise<void>;
}

// Compute target capacity (pure/deterministic). Clamp demand to [min,max].
export function desiredCapacity(load: LoadSignal, current: number, policy: AutoscalePolicy): number {
  const demand = policy.targetSlots ? policy.targetSlots(load, current) : load.inFlight + load.queued;
  return Math.max(policy.min, Math.min(policy.max, Math.ceil(demand)));
}

// An in-memory slot count — injected into a backend's maxConcurrent as a fn to form a closed loop.
export class MutableSlots implements ScalingTarget {
  constructor(
    readonly id: string,
    private slots: number,
  ) {}
  current(): number {
    return this.slots;
  }
  scaleTo(desired: number): void {
    this.slots = desired;
  }
  // The getter to pass as a backend's maxConcurrent.
  readonly get = (): number => this.slots;
}

export interface AutoscalerOptions {
  signal: () => LoadSignal; // e.g. () => aggregateStats(scheduler)
  targets: ScalingTarget[];
  policy: AutoscalePolicy;
  intervalMs?: number; // the tick interval of start() (default 1000)
  onScale?: (targetId: string, from: number, to: number) => void;
  onChanged?: () => void; // called right after a scale — the scheduler re-pump hook (sched.poke)
}

export class Autoscaler {
  private readonly downTicks = new Map<string, number>(); // consecutive down-candidate ticks per target
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: AutoscalerOptions) {}

  async tick(): Promise<void> {
    const load = this.opts.signal();
    const threshold = this.opts.policy.scaleDownAfterTicks ?? 3;
    let changed = false;
    for (const target of this.opts.targets) {
      const cur = await target.current();
      const desired = desiredCapacity(load, cur, this.opts.policy);
      if (desired > cur) {
        this.downTicks.set(target.id, 0);
        await target.scaleTo(desired); // upscale immediately (clear the backlog first)
        this.opts.onScale?.(target.id, cur, desired);
        changed = true;
      } else if (desired < cur) {
        const d = (this.downTicks.get(target.id) ?? 0) + 1;
        this.downTicks.set(target.id, d);
        if (d >= threshold) {
          // downscale only when idle/over-provision persists long enough (anti-flapping)
          this.downTicks.set(target.id, 0);
          await target.scaleTo(desired);
          this.opts.onScale?.(target.id, cur, desired);
          changed = true;
        }
      } else {
        this.downTicks.set(target.id, 0);
      }
    }
    if (changed) this.opts.onChanged?.();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

// Scheduler stats() → LoadSignal (convenience).
export function aggregateLoad(stats: { queued: number; inFlight: Record<string, number> }): LoadSignal {
  return { queued: stats.queued, inFlight: Object.values(stats.inFlight).reduce((a, b) => a + b, 0) };
}
