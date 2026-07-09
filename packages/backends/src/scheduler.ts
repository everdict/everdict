import { type AgentJob, type CaseResult, InternalError, NotFoundError, RateLimitError } from "@everdict/core";
import { type DispatchOptions, dispatchAborted } from "./backend.js";
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
  // Free memory of the backend's declared admission envelope (Infinity when the backend declares none) —
  // a job's harness-declared memory must fit here, so slots-free-but-memory-full backends stop admitting.
  memFreeMb: number;
  // Free CPU of the declared envelope (resources.cpu units; Infinity when none declared) — same contract as memFreeMb.
  cpuFree: number;
}

// The memory a job asks of the admission envelope — the harness's declared weight. Undeclared → 0 (admitted
// outside the memory budget; resource-aware admission is opt-in by declaring resources on the harness).
const jobMemoryMb = (job: AgentJob): number =>
  job.harnessSpec?.kind === "command" ? (job.harnessSpec.resources?.memoryMb ?? 0) : 0;
// The CPU twin (resources.cpu, 1000 = 1 vCPU) — same opt-in contract as jobMemoryMb.
const jobCpu = (job: AgentJob): number =>
  job.harnessSpec?.kind === "command" ? (job.harnessSpec.resources?.cpu ?? 0) : 0;

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
  enqueuedAt: number; // aging clock — a long-waiting batch entry is promoted to the urgent scan (starvation guard)
  resolve: (r: CaseResult) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal; // per-dispatch cancellation — forwarded to the backend once in-flight
  onAbort?: () => void; // the queued-abort listener, detached when the entry leaves the queue
}

export interface SchedulerOptions {
  policy?: PlacementPolicy;
  maxQueueDepth?: number; // backpressure: RateLimitError(429) once the queue fills to this
  // A custom hook to restrict candidates (e.g. harness↔backend matching) — if unset, the pin or all backends.
  eligible?: (job: AgentJob, names: string[]) => string[];
  // Multi-tenant fairness: WFQ weight (larger = more often) + per-tenant concurrent-execution cap (quota).
  weightFor?: (tenant: string) => number; // default 1
  tenantQuota?: (tenant: string) => number; // default unlimited
  // Per-tenant QUEUE depth cap — the global maxQueueDepth alone lets one tenant fill the whole queue (its
  // in-flight quota caps execution, not waiting). Over the cap ⇒ RateLimitError(429) at dispatch. Default unlimited.
  tenantMaxQueueDepth?: (tenant: string) => number;
  // Priority aging (starvation guard) — a queued entry older than this is scanned with the interactive class
  // regardless of its own priority, so an interactive flood can't starve batch work forever. Default 60s.
  agingMs?: number;
  now?: () => number; // injectable clock (aging tests)
  // Tenant budget: admit on dispatch (402 if over), settle cost on completion.
  budget?: BudgetTracker;
}

// A capacity-aware + tenant-fair scheduler: place jobs where there's room based on backend free capacity, but pull
// waiting jobs in WFQ (weighted fair queue) order and don't exceed each tenant's quota. If there's no room/quota,
// queue and then auto-pump when a slot frees (HOL avoidance). Dispatcher-compatible (drop-in).
export class Scheduler {
  private readonly policy: PlacementPolicy;
  private readonly inFlight = new Map<string, number>(); // backend name → in-flight
  private readonly memInFlight = new Map<string, number>(); // backend name → in-flight harness-declared memory (Mb)
  private readonly cpuInFlight = new Map<string, number>(); // backend name → in-flight harness-declared cpu (resources.cpu units)
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

  dispatch(job: AgentJob, opts?: DispatchOptions): Promise<CaseResult> {
    // Already cancelled before we did anything — reject without admitting a budget run or touching the queue.
    if (opts?.signal?.aborted) return Promise.reject(dispatchAborted(job));
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
    const tenant = tenantOf(job);
    const tenantMax = this.opts.tenantMaxQueueDepth?.(tenant) ?? Number.POSITIVE_INFINITY;
    if ((this.queue.queuedByTenant()[tenant] ?? 0) >= tenantMax) {
      return Promise.reject(
        new RateLimitError(
          "RATE_LIMITED",
          { tenant, queueDepth: this.queue.queuedByTenant()[tenant] },
          "this workspace's scheduler queue is full.",
        ),
      );
    }
    return new Promise<CaseResult>((resolve, reject) => {
      const entry: QueueEntry = {
        job,
        enqueuedAt: (this.opts.now ?? Date.now)(),
        resolve,
        reject,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      };
      if (opts?.signal) {
        // Aborted while still QUEUED → remove and reject, so a cancelled job never wastes a placement slot. Once
        // in-flight this listener is detached (see pump) and cancellation flows to the backend via the signal instead.
        const onAbort = (): void => {
          if (this.queue.remove(entry)) reject(dispatchAborted(job));
        };
        entry.onAbort = onAbort;
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.queue.enqueue(entry);
      void this.pump();
    });
  }

  // Wake the scheduler to re-evaluate the queue when capacity was increased externally (the autoscaler).
  poke(): void {
    void this.pump();
  }

  // Cancel QUEUED (not-yet-dispatched) jobs matching the predicate — reclaim for a superseded batch or a
  // speculation loser. The entry's promise rejects with CANCELLED (classified infra-retryable, but every caller
  // either swallows it [speculation race already settled] or has aborted its retry loop [supersede]). In-flight
  // jobs are untouched — reclaiming those is Backend.kill's job.
  cancelQueued(predicate: (job: AgentJob) => boolean): number {
    let cancelled = 0;
    for (const entry of this.queue.ordered()) {
      if (!predicate(entry.job)) continue;
      this.queue.remove(entry);
      entry.reject(new InternalError("CANCELLED", { caseId: entry.job.evalCase.id }, "cancelled while queued."));
      cancelled += 1;
    }
    return cancelled;
  }

  // A snapshot for observation (test/monitoring).
  stats(): {
    queued: number;
    inFlight: Record<string, number>;
    memInFlightMb: Record<string, number>;
    cpuInFlight: Record<string, number>;
    tenantInFlight: Record<string, number>;
    queuedByTenant: Record<string, number>;
  } {
    return {
      queued: this.queue.size,
      inFlight: Object.fromEntries(this.inFlight),
      memInFlightMb: Object.fromEntries(this.memInFlight),
      cpuInFlight: Object.fromEntries(this.cpuInFlight),
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
        const memFreeMb =
          cap.memoryBudgetMb === undefined
            ? Number.POSITIVE_INFINITY
            : Math.max(0, cap.memoryBudgetMb - (this.memInFlight.get(name) ?? 0));
        const cpuFree =
          cap.cpuBudget === undefined
            ? Number.POSITIVE_INFINITY
            : Math.max(0, cap.cpuBudget - (this.cpuInFlight.get(name) ?? 0));
        slots.set(name, { name, total: cap.total, free: Math.max(0, cap.total - used), memFreeMb, cpuFree });
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
        // Priority classes first: interactive jobs (a person is waiting — single runs) jump ahead of batch
        // fan-out, while the tenant-fair WFQ order is preserved WITHIN each class (stable partition).
        // AGING: an entry waiting past agingMs joins the urgent class regardless of its own priority — an
        // interactive flood must not starve batch work forever.
        const nowMs = (this.opts.now ?? Date.now)();
        const agingMs = this.opts.agingMs ?? 60_000;
        const urgent = (e: QueueEntry): boolean => e.job.priority === "interactive" || nowMs - e.enqueuedAt >= agingMs;
        const ordered = this.queue.ordered();
        const scan = [...ordered.filter(urgent), ...ordered.filter((e) => !urgent(e))];
        for (const entry of scan) {
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

          // Slots AND memory: a heavy harness (declared resources.memoryMb) only goes where its memory fits the
          // backend's remaining admission envelope — slots-free-but-memory-full backends stop admitting heavy jobs.
          const memNeed = jobMemoryMb(entry.job);
          const cpuNeed = jobCpu(entry.job);
          const candidates = names
            .map((n) => slots.get(n))
            .filter(
              (s): s is BackendSlot => s !== undefined && s.free > 0 && memNeed <= s.memFreeMb && cpuNeed <= s.cpuFree,
            );
          if (candidates.length === 0) continue; // no room right now → try the next job

          const chosen = this.policy.choose(candidates, entry.job);
          if (chosen === undefined) continue;

          this.queue.remove(entry);
          // Leaving the queue → detach the queued-abort listener; from here cancellation rides the signal we hand
          // to backend.dispatch below (the backend stops its poll and reclaims the orchestrator job).
          if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
          const slot = slots.get(chosen);
          if (slot) {
            slot.free -= 1; // local decrement within the same pump pass
            slot.memFreeMb -= memNeed;
            slot.cpuFree -= cpuNeed;
          }
          this.inFlight.set(chosen, (this.inFlight.get(chosen) ?? 0) + 1);
          if (memNeed > 0) this.memInFlight.set(chosen, (this.memInFlight.get(chosen) ?? 0) + memNeed);
          if (cpuNeed > 0) this.cpuInFlight.set(chosen, (this.cpuInFlight.get(chosen) ?? 0) + cpuNeed);
          this.tenantInFlight.set(tenant, (this.tenantInFlight.get(tenant) ?? 0) + 1);
          this.runOne(entry, chosen, tenant, memNeed, cpuNeed);
          placedAny = true;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private runOne(entry: QueueEntry, name: string, tenant: string, memNeedMb: number, cpuNeed: number): void {
    this.registry
      .get(name)
      .dispatch(entry.job, entry.signal ? { signal: entry.signal } : undefined)
      .then((result) => {
        this.opts.budget?.settle(tenant, costOf(result)); // commit the actual cost on completion
        entry.resolve(result);
      }, entry.reject)
      .finally(() => {
        this.inFlight.set(name, Math.max(0, (this.inFlight.get(name) ?? 1) - 1));
        if (memNeedMb > 0)
          this.memInFlight.set(name, Math.max(0, (this.memInFlight.get(name) ?? memNeedMb) - memNeedMb));
        if (cpuNeed > 0) this.cpuInFlight.set(name, Math.max(0, (this.cpuInFlight.get(name) ?? cpuNeed) - cpuNeed));
        this.tenantInFlight.set(tenant, Math.max(0, (this.tenantInFlight.get(tenant) ?? 1) - 1));
        void this.pump();
      });
  }
}
