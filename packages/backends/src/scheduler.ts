import { type AgentJob, type CaseResult, NotFoundError, RateLimitError } from "@everdict/core";
import { type BudgetTracker, costOf } from "./budget.js";
import { FairQueue } from "./fair-queue.js";
import type { BackendRegistry } from "./registry.js";

const DEFAULT_TENANT = "default";
const tenantOf = (job: AgentJob): string => job.tenant ?? DEFAULT_TENANT;

// A snapshot of one backend's available slots.
export interface BackendSlot {
  name: string;
  free: number;
  total: number;
}

// The placement policy that picks one of the candidates with room (must be pure/deterministic).
export interface PlacementPolicy {
  choose(candidates: BackendSlot[], job: AgentJob): string | undefined;
}

// The one with the most room (spread). Ties broken deterministically by name.
export const leastLoadedPolicy: PlacementPolicy = {
  choose(candidates) {
    return [...candidates].sort((a, b) => b.free - a.free || a.name.localeCompare(b.name))[0]?.name;
  },
};

// The one with the least room but ≥1 (pack/bin-pack). Favorable for scale-to-zero of idle pools.
export const binPackPolicy: PlacementPolicy = {
  choose(candidates) {
    return [...candidates].sort((a, b) => a.free - b.free || a.name.localeCompare(b.name))[0]?.name;
  },
};

interface QueueEntry {
  job: AgentJob;
  resolve: (r: CaseResult) => void;
  reject: (e: unknown) => void;
}

export interface SchedulerOptions {
  policy?: PlacementPolicy;
  maxQueueDepth?: number; // backpressure: RateLimitError(429) once the queue fills to this
  // A custom hook to restrict candidates (e.g. harness↔backend matching) — if unset, the pin or all backends.
  eligible?: (job: AgentJob, names: string[]) => string[];
  // Multi-tenant fairness: WFQ weight (larger = more often) + per-tenant concurrent-execution cap (quota).
  weightFor?: (tenant: string) => number; // default 1
  tenantQuota?: (tenant: string) => number; // default unlimited
  // Tenant budget: admit on dispatch (402 if over), settle cost on completion.
  budget?: BudgetTracker;
}

// A capacity-aware + tenant-fair scheduler: place jobs where there's room based on backend free capacity, but pull
// waiting jobs in WFQ (weighted fair queue) order and don't exceed each tenant's quota. If there's no room/quota,
// queue and then auto-pump when a slot frees (HOL avoidance). Dispatcher-compatible (drop-in).
export class Scheduler {
  private readonly policy: PlacementPolicy;
  private readonly inFlight = new Map<string, number>(); // backend name → in-flight
  private readonly tenantInFlight = new Map<string, number>(); // tenant → in-flight
  private readonly queue: FairQueue<QueueEntry>;
  private pumping = false;

  constructor(
    private readonly registry: BackendRegistry,
    private readonly opts: SchedulerOptions = {},
  ) {
    this.policy = opts.policy ?? leastLoadedPolicy;
    this.queue = new FairQueue<QueueEntry>({
      tenantOf: (e) => tenantOf(e.job),
      weightFor: opts.weightFor,
    });
  }

  dispatch(job: AgentJob): Promise<CaseResult> {
    // Budget admit — if over, reject immediately before queuing (402). If it passes, reserve one run (burst-cap protection).
    try {
      this.opts.budget?.admit(tenantOf(job));
    } catch (err) {
      return Promise.reject(err);
    }
    const max = this.opts.maxQueueDepth ?? Number.POSITIVE_INFINITY;
    if (this.queue.size >= max) {
      return Promise.reject(
        new RateLimitError("RATE_LIMITED", { queueDepth: this.queue.size }, "the scheduler queue is full."),
      );
    }
    return new Promise<CaseResult>((resolve, reject) => {
      this.queue.enqueue({ job, resolve, reject });
      void this.pump();
    });
  }

  // Wake the scheduler to re-evaluate the queue when capacity was increased externally (the autoscaler).
  poke(): void {
    void this.pump();
  }

  // A snapshot for observation (test/monitoring).
  stats(): {
    queued: number;
    inFlight: Record<string, number>;
    tenantInFlight: Record<string, number>;
    queuedByTenant: Record<string, number>;
  } {
    return {
      queued: this.queue.size,
      inFlight: Object.fromEntries(this.inFlight),
      tenantInFlight: Object.fromEntries(this.tenantInFlight),
      queuedByTenant: this.queue.queuedByTenant(),
    };
  }

  private eligibleNames(job: AgentJob): string[] {
    const pin = job.evalCase.placement?.target;
    if (pin) {
      if (!this.registry.has(pin)) {
        throw new NotFoundError("NOT_FOUND", { backend: pin }, `backend '${pin}' is not registered.`);
      }
      return [pin];
    }
    const all = this.registry.names();
    return this.opts.eligible ? this.opts.eligible(job, all) : all;
  }

  private async freeSlots(): Promise<Map<string, BackendSlot>> {
    const slots = new Map<string, BackendSlot>();
    await Promise.all(
      this.registry.names().map(async (name) => {
        const cap = await this.registry.get(name).capacity();
        const used = Math.max(cap.used, this.inFlight.get(name) ?? 0);
        slots.set(name, { name, total: cap.total, free: Math.max(0, cap.total - used) });
      }),
    );
    return slots;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return; // reentrancy guard — when one pump ends, settle calls it again
    this.pumping = true;
    try {
      let placedAny = true;
      while (placedAny && this.queue.size > 0) {
        placedAny = false;
        const slots = await this.freeSlots();
        // Scan in WFQ fair order, but skip jobs that can't be sent now due to quota/capacity (HOL avoidance).
        for (const entry of this.queue.ordered()) {
          const tenant = tenantOf(entry.job);
          const quota = this.opts.tenantQuota?.(tenant) ?? Number.POSITIVE_INFINITY;
          if ((this.tenantInFlight.get(tenant) ?? 0) >= quota) continue; // tenant quota reached

          let names: string[];
          try {
            names = this.eligibleNames(entry.job);
          } catch (err) {
            // e.g. an unregistered pin → fail just that job immediately and continue.
            this.queue.remove(entry);
            entry.reject(err);
            placedAny = true;
            continue;
          }

          const candidates = names
            .map((n) => slots.get(n))
            .filter((s): s is BackendSlot => s !== undefined && s.free > 0);
          if (candidates.length === 0) continue; // no room right now → try the next job

          const chosen = this.policy.choose(candidates, entry.job);
          if (chosen === undefined) continue;

          this.queue.remove(entry);
          const slot = slots.get(chosen);
          if (slot) slot.free -= 1; // local decrement within the same pump pass
          this.inFlight.set(chosen, (this.inFlight.get(chosen) ?? 0) + 1);
          this.tenantInFlight.set(tenant, (this.tenantInFlight.get(tenant) ?? 0) + 1);
          this.runOne(entry, chosen, tenant);
          placedAny = true;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private runOne(entry: QueueEntry, name: string, tenant: string): void {
    this.registry
      .get(name)
      .dispatch(entry.job)
      .then((result) => {
        this.opts.budget?.settle(tenant, costOf(result)); // commit the actual cost on completion
        entry.resolve(result);
      }, entry.reject)
      .finally(() => {
        this.inFlight.set(name, Math.max(0, (this.inFlight.get(name) ?? 1) - 1));
        this.tenantInFlight.set(tenant, Math.max(0, (this.tenantInFlight.get(tenant) ?? 1) - 1));
        void this.pump();
      });
  }
}
