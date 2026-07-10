import { type AgentJob, type CaseResult, InternalError, NotFoundError, RateLimitError } from "@everdict/contracts";
import { type BudgetTracker, FairQueue, costOf } from "@everdict/domain";
import { type BackendCapacity, type DispatchOptions, dispatchAborted } from "../backend.js";
import type { BackendRegistry } from "../placement/registry.js";

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

// In-flight accounting for the Scheduler: reserve on placement, release on completion. One object keeps the four
// dimensions (backend slots / memory / cpu, tenant count) in lockstep, so the reserve/release invariant lives in one
// place instead of four parallel maps diddled at two call sites.
class Admission {
  private readonly backendCounts = new Map<string, number>();
  private readonly backendMemMb = new Map<string, number>();
  private readonly backendCpu = new Map<string, number>();
  private readonly tenantCounts = new Map<string, number>();

  reserve(backend: string, tenant: string, memMb: number, cpu: number): void {
    bump(this.backendCounts, backend, 1);
    if (memMb > 0) bump(this.backendMemMb, backend, memMb);
    if (cpu > 0) bump(this.backendCpu, backend, cpu);
    bump(this.tenantCounts, tenant, 1);
  }

  release(backend: string, tenant: string, memMb: number, cpu: number): void {
    bump(this.backendCounts, backend, -1);
    if (memMb > 0) bump(this.backendMemMb, backend, -memMb);
    if (cpu > 0) bump(this.backendCpu, backend, -cpu);
    bump(this.tenantCounts, tenant, -1);
  }

  countFor(backend: string): number {
    return this.backendCounts.get(backend) ?? 0;
  }
  memMbFor(backend: string): number {
    return this.backendMemMb.get(backend) ?? 0;
  }
  cpuFor(backend: string): number {
    return this.backendCpu.get(backend) ?? 0;
  }
  tenantCountFor(tenant: string): number {
    return this.tenantCounts.get(tenant) ?? 0;
  }

  snapshot(): {
    inFlight: Record<string, number>;
    memInFlightMb: Record<string, number>;
    cpuInFlight: Record<string, number>;
    tenantInFlight: Record<string, number>;
  } {
    return {
      inFlight: Object.fromEntries(this.backendCounts),
      memInFlightMb: Object.fromEntries(this.backendMemMb),
      cpuInFlight: Object.fromEntries(this.backendCpu),
      tenantInFlight: Object.fromEntries(this.tenantCounts),
    };
  }
}

// Add delta to a counter map, clamped at 0 (never negative).
function bump(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, Math.max(0, (map.get(key) ?? 0) + delta));
}

// A capacity-aware + tenant-fair scheduler: place jobs where there's room based on backend free capacity, but pull
// waiting jobs in WFQ (weighted fair queue) order and don't exceed each tenant's quota. If there's no room/quota,
// queue and then auto-pump when a slot frees (HOL avoidance). Dispatcher-compatible (drop-in).
export class Scheduler {
  private readonly policy: PlacementPolicy;
  // In-flight accounting across backend slots / memory / cpu and per-tenant count — reserved on placement, released
  // on completion (see Admission), replacing four parallel maps.
  private readonly admission = new Admission();
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
    // Already cancelled before we did anything — reject without touching the budget or the queue.
    if (opts?.signal?.aborted) return Promise.reject(dispatchAborted(job));
    const tenant = tenantOf(job);
    // Backpressure checks run BEFORE the budget admit — otherwise a queue-full / over-quota rejection would leak
    // admit()'s reserved run (never dispatched, never settled), permanently inflating the tenant's run count and
    // eventually 402-ing them for jobs that never ran. Admit only once the job is guaranteed to be enqueued.
    const max = this.opts.maxQueueDepth ?? Number.POSITIVE_INFINITY;
    if (this.queue.size >= max) {
      return Promise.reject(
        new RateLimitError("RATE_LIMITED", { queueDepth: this.queue.size }, "the scheduler queue is full."),
      );
    }
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
    // Budget admit — over-limit ⇒ 402 before queuing; on pass, reserve one run (burst-cap protection).
    try {
      this.opts.budget?.admit(tenant);
    } catch (err) {
      return Promise.reject(err);
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
          if (this.queue.remove(entry)) {
            this.releaseBudget(job); // admitted-then-cancelled while queued → give the reserved run back
            reject(dispatchAborted(job));
          }
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
      this.releaseBudget(entry.job); // superseded/speculation-loser while queued → refund its admit reservation
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
      ...this.admission.snapshot(),
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

  // Probe every backend's capacity once — the ONLY cluster round-trip in a pump. Nomad/K8s capacity() is a live HTTP
  // probe, so it must not run per placement: external usage doesn't change within a single drain, and the scheduler's
  // own placements are tracked locally in inFlight (see freeSlotsFrom). Probing per round was O(rounds) probes/pump.
  private async probeCapacities(): Promise<Map<string, BackendCapacity>> {
    const caps = new Map<string, BackendCapacity>();
    await Promise.all(
      this.registry.names().map(async (name) => {
        caps.set(name, await this.registry.get(name).capacity());
      }),
    );
    return caps;
  }

  // Free slots from a capacity snapshot + the scheduler's live in-flight counts — pure, recomputed each placement
  // round with no HTTP. used = max(probe, ownInFlight) so a lagging probe can't let us over-admit our own placements.
  private freeSlotsFrom(caps: Map<string, BackendCapacity>): Map<string, BackendSlot> {
    const slots = new Map<string, BackendSlot>();
    for (const [name, cap] of caps) {
      const used = Math.max(cap.used, this.admission.countFor(name));
      const memFreeMb =
        cap.memoryBudgetMb === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, cap.memoryBudgetMb - this.admission.memMbFor(name));
      const cpuFree =
        cap.cpuBudget === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, cap.cpuBudget - this.admission.cpuFor(name));
      slots.set(name, { name, total: cap.total, free: Math.max(0, cap.total - used), memFreeMb, cpuFree });
    }
    return slots;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return; // reentrancy guard — when one pump ends, settle calls it again
    this.pumping = true;
    try {
      if (this.queue.size === 0) return; // nothing to place — don't probe the cluster
      let placedAny = true;
      const caps = await this.probeCapacities(); // ONE cluster probe per drain, reused across placement rounds
      while (placedAny && this.queue.size > 0) {
        placedAny = false;
        const slots = this.freeSlotsFrom(caps); // recompute from the snapshot + live in-flight (no HTTP)
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
          if (this.admission.tenantCountFor(tenant) >= quota) continue; // tenant quota reached

          let names: string[];
          try {
            names = this.eligibleNames(entry.job);
          } catch (err) {
            // e.g. an unregistered pin → fail just that job immediately and continue.
            this.queue.remove(entry);
            this.releaseBudget(entry.job); // admitted but never dispatched → refund the reserved run
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
          this.admission.reserve(chosen, tenant, memNeed, cpuNeed);
          this.runOne(entry, chosen, tenant, memNeed, cpuNeed);
          placedAny = true;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  // Give back a queued job's admit reservation when it leaves the queue WITHOUT being dispatched (abort / supersede /
  // placement failure); a dispatched job that later fails still ran, so it is NOT released here.
  private releaseBudget(job: AgentJob): void {
    this.opts.budget?.release(tenantOf(job));
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
        this.admission.release(name, tenant, memNeedMb, cpuNeed);
        void this.pump();
      });
  }
}
