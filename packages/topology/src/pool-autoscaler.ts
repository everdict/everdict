import { Autoscaler, type ScalingTarget } from "@everdict/domain";

// The actuation half of elastic capacity: grow/shrink the SESSION SERVICE behind each scalable pool from the
// same two signals the placement plane already reads — the pool's live saturation and the scheduler backlog.
// The sensing half (ServiceTopologyBackend.capacity() following the live pool) then widens admission on its own
// once the scaled-out service reports a bigger pool; nothing else needs to know a scale happened.
//
// One domain Autoscaler per pool (keyed by warm identity): upscale is immediate, downscale waits out the
// hysteresis (scaleDownAfterTicks), and the replica bounds are the harness-declared acquire.capacity.scale —
// per-pool policy, which is exactly why the pools don't share one Autoscaler. Demand is translated from
// sessions to replicas via the pool's own ratio (total sessions ÷ current replicas), so a service holding 8
// sessions per replica scales by eights, not by ones.

// What one scalable pool looks like to this manager — structurally satisfied by the entries
// ServiceTopologyBackend.poolScalingTargets() returns (faked directly in tests).
export interface ScalablePool {
  key: string; // warm identity (spec id@effectiveVersion, zone-suffixed) — the Autoscaler's stable handle
  bounds: { min: number; max: number }; // harness-declared replica bounds (acquire.capacity.scale)
  pool: { total: number; used?: number }; // the LAST pool reading (refreshed by the capacity probes)
  target: ScalingTarget; // current() = live desired-replica read (throws when unreadable); scaleTo() = the write
}

export interface PoolAutoscalerHost {
  poolScalingTargets(): ScalablePool[];
}

export interface TopologyPoolAutoscalerOptions {
  hosts: () => PoolAutoscalerHost[]; // live roster — rt: backends register/retire dynamically
  // Backlog attributable to THIS pool (queued cases of the pool's harness). Global backlog would over-scale
  // every pool for one harness's burst.
  queuedFor: (key: string) => number;
  intervalMs?: number; // tick cadence (default 15s — a kubectl read per pool per tick rides on this)
  scaleDownAfterTicks?: number; // downscale hysteresis, in ticks (default 3)
  onScale?: (key: string, from: number, to: number) => void; // observability hook
  onScaled?: () => void; // re-pump hook (scheduler.poke) — newly scaled capacity should drain the queue
}

export class TopologyPoolAutoscaler {
  // Per-pool Autoscaler + the mutable pool reading its signal closure reads each tick. Bounds are immutable per
  // key (a new harness version is a new warm identity), so they are captured at construction.
  private readonly perPool = new Map<
    string,
    { autoscaler: Autoscaler; latest: { total: number; used: number | undefined } }
  >();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: TopologyPoolAutoscalerOptions) {}

  async tick(): Promise<void> {
    const seen = new Set<string>();
    for (const host of this.opts.hosts()) {
      for (const scalable of host.poolScalingTargets()) {
        seen.add(scalable.key);
        let entry = this.perPool.get(scalable.key);
        if (!entry) {
          const latest = { total: scalable.pool.total, used: scalable.pool.used };
          const autoscaler = new Autoscaler({
            // inFlight = sessions held right now; a pool that doesn't report `used` counts as full — with no
            // backlog that solves to the current size (stable), with backlog it scales up (the safe reading).
            signal: () => ({ queued: this.opts.queuedFor(scalable.key), inFlight: latest.used ?? latest.total }),
            targets: [scalable.target],
            policy: {
              min: scalable.bounds.min,
              max: scalable.bounds.max,
              // sessions → replicas via the pool's own per-replica ratio. current=0 (scaled to zero) treats the
              // whole pool as one replica's worth, so any demand asks for at least one.
              targetSlots: (load, current) => {
                const perReplica = current > 0 ? latest.total / current : latest.total;
                if (perReplica <= 0) return current; // an empty pool sizes nothing — hold position
                return (load.inFlight + load.queued) / perReplica;
              },
              ...(this.opts.scaleDownAfterTicks !== undefined
                ? { scaleDownAfterTicks: this.opts.scaleDownAfterTicks }
                : {}),
            },
            ...(this.opts.onScale ? { onScale: (_id, from, to) => this.opts.onScale?.(scalable.key, from, to) } : {}),
            ...(this.opts.onScaled ? { onChanged: this.opts.onScaled } : {}),
          });
          entry = { autoscaler, latest };
          this.perPool.set(scalable.key, entry);
        } else {
          entry.latest.total = scalable.pool.total;
          entry.latest.used = scalable.pool.used;
        }
        try {
          await entry.autoscaler.tick();
        } catch {
          // one pool's unreadable replicas / failed scale must not stall the other pools' ticks
        }
      }
    }
    // Pools that vanished (warm sweep / version superseded) take their Autoscaler state with them.
    for (const key of [...this.perPool.keys()]) if (!seen.has(key)) this.perPool.delete(key);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 15_000);
    this.timer.unref?.(); // a background loop must never hold the process open
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
