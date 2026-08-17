import type { AdmissionLedger } from "@everdict/application-control";
import {
  type AttemptRef,
  type CaseJob,
  type CaseResult,
  InternalError,
  NotFoundError,
  type PersistedWorkIntent,
  RateLimitError,
  type RuntimeWorkRef,
} from "@everdict/contracts";
import { type BudgetTracker, FairQueue, costOf } from "@everdict/domain";
import { type BackendCapacity, type DispatchOptions, dispatchAborted, isCaseCapacityAware } from "../backend.js";
import type { BackendRegistry } from "../placement/registry.js";

const DEFAULT_TENANT = "default";
const tenantOf = (job: CaseJob): string => job.tenant ?? DEFAULT_TENANT;
// The per-harness admission key (harness-keyed capacity) — the requested identity; a backend's own warm keys
// (pin-suffixed versions, zones) fold into it inside capacityFor.
const harnessKeyOf = (job: CaseJob): string => `${job.harness.id}@${job.harness.version}`;

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
const jobMemoryMb = (job: CaseJob): number =>
  job.harnessSpec?.kind === "command" ? (job.harnessSpec.resources?.memoryMb ?? 0) : 0;
// The CPU twin (resources.cpu, 1000 = 1 vCPU) — same opt-in contract as jobMemoryMb.
const jobCpu = (job: CaseJob): number =>
  job.harnessSpec?.kind === "command" ? (job.harnessSpec.resources?.cpu ?? 0) : 0;

// The placement policy that picks one of the candidates with room (must be pure/deterministic).
export interface PlacementPolicy {
  choose(candidates: BackendSlot[], job: CaseJob): string | undefined;
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
  id: string; // stable snapshot handle (q<seq>) — what the queue page cancels/promotes by
  permitId?: string; // the fleet-wide admission permit this entry holds (AdmissionLedger.tryAdmit) — released at settle
  job: CaseJob;
  enqueuedAt: number; // aging clock — a long-waiting batch entry is promoted to the urgent scan (starvation guard)
  promoted?: boolean; // operator "jump the line" — scanned with the urgent class and moved to the fair-order front
  resolve: (r: CaseResult) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal; // per-dispatch cancellation — forwarded to the backend once in-flight
  onAbort?: () => void; // the queued-abort listener, detached when the entry leaves the queue
  onStarted?: () => void; // fires when the entry leaves the wait queue and is dispatched — forwarded to the backend
  onWaiting?: (reason: string) => void; // "cannot start now + why" (blocked placement / no online runner) — forwarded to the backend
  onAttempt?: (attempt: AttemptRef) => void; // "the attempt that is actually executing" (self-hosted re-lease) — forwarded to the backend
  // "the external object this dispatch is ABOUT to create" — forwarded to the backend, which awaits it before
  // it creates anything (arch-review 53, Wave A) and requires the store's proof back (arch-review 54, Phase 1).
  onReserved?: (work: RuntimeWorkRef) => Promise<PersistedWorkIntent>;
}

export interface SchedulerOptions {
  policy?: PlacementPolicy;
  maxQueueDepth?: number; // backpressure: RateLimitError(429) once the queue fills to this
  // A custom hook to restrict candidates (e.g. harness↔backend matching) — if unset, the pin or all backends.
  eligible?: (job: CaseJob, names: string[]) => string[];
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
  // The durable run ledger (docs/architecture/multi-replica.md). Without it `tenantQuota` bounds what THIS
  // process holds, so a deployment of N replicas grants every workspace N quotas; with it the quota is
  // fleet-wide. Optional on purpose: a single-process control plane (dev, the CLI worker) needs no ledger and
  // behaves exactly as before. Read once per drain, like the cluster capacity probe.
  ledger?: AdmissionLedger;
  // How often this replica renews the lease on the permits its in-flight work holds (default 10 minutes —
  // well inside the ledger's lease window, so several missed beats still never look like a dead holder).
  permitRenewMs?: number;
}

// The fleet's tenant in-flight, as ONE drain sees it: the ledger reading taken at the top of the drain plus
// whatever this process has placed since. The reading already includes our own running rows, so adding the
// whole local count would double-count them — only the delta since the reading is ours to add, and the `max`
// keeps us honest when the ledger lags behind rows we have only just dispatched.
class FleetInFlight {
  constructor(
    private readonly atProbe: Record<string, number>,
    private readonly localAtProbe: Record<string, number>,
  ) {}

  countFor(tenant: string, localNow: number): number {
    const placedSinceProbe = Math.max(0, localNow - (this.localAtProbe[tenant] ?? 0));
    return Math.max(localNow, (this.atProbe[tenant] ?? 0) + placedSinceProbe);
  }
}

// In-flight accounting for the Scheduler: reserve on placement, release on completion. One object keeps the four
// dimensions (backend slots / memory / cpu, tenant count) in lockstep, so the reserve/release invariant lives in one
// place instead of four parallel maps diddled at two call sites.
class Admission {
  private readonly backendCounts = new Map<string, number>();
  private readonly backendMemMb = new Map<string, number>();
  private readonly backendCpu = new Map<string, number>();
  private readonly tenantCounts = new Map<string, number>();
  // Per-(backend, harness@version) in-flight — the fifth dimension, for harness-keyed capacity (a topology
  // backend's session pools are per harness): within one pump the pool reading is a snapshot, so our OWN
  // placements of that harness must be counted locally or a single drain over-admits into one pool.
  private readonly harnessCounts = new Map<string, number>();

  reserve(backend: string, tenant: string, memMb: number, cpu: number, harness: string): void {
    bump(this.backendCounts, backend, 1);
    if (memMb > 0) bump(this.backendMemMb, backend, memMb);
    if (cpu > 0) bump(this.backendCpu, backend, cpu);
    bump(this.tenantCounts, tenant, 1);
    bump(this.harnessCounts, `${backend}|${harness}`, 1);
  }

  release(backend: string, tenant: string, memMb: number, cpu: number, harness: string): void {
    bump(this.backendCounts, backend, -1);
    if (memMb > 0) bump(this.backendMemMb, backend, -memMb);
    if (cpu > 0) bump(this.backendCpu, backend, -cpu);
    bump(this.tenantCounts, tenant, -1);
    bump(this.harnessCounts, `${backend}|${harness}`, -1);
  }

  countFor(backend: string): number {
    return this.backendCounts.get(backend) ?? 0;
  }
  harnessCountFor(backend: string, harness: string): number {
    return this.harnessCounts.get(`${backend}|${harness}`) ?? 0;
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

// Add delta to a counter map, clamped at 0 (never negative). At zero the key is DELETED, not left as a 0 entry:
// these maps are keyed by backend name (`rt:<tenant>:<id>@<ver>`, `self:<owner>:<runnerId>`) and tenant, so under
// runtime/runner churn a lingering 0 accretes one dead entry per distinct backend ever scheduled — an unbounded
// leak on a long-running scheduler. get() reads `?? 0`, so a deleted-then-recreated key is identical.
function bump(map: Map<string, number>, key: string, delta: number): void {
  const next = Math.max(0, (map.get(key) ?? 0) + delta);
  if (next === 0) map.delete(key);
  else map.set(key, next);
}

// One waiting entry as the queue page sees it — identity + placement facts + its spot in the effective scan
// order. This is the SCHEDULER's own queue (the WFQ the pump actually drains), not the record-status projection.
export interface SchedulerQueueEntry {
  id: string;
  tenant: string;
  caseId: string;
  runId?: string;
  batchId?: string;
  harness: { id: string; version: string };
  target?: string; // pinned placement target (the runtime lane it is waiting for)
  priority?: CaseJob["priority"];
  tags?: string[]; // evalCase tags — e.g. ["judge"] marks a control-plane judge job
  enqueuedAt: number; // epoch ms
  urgent: boolean; // scanned in the urgent class (interactive / promoted / aged past agingMs)
  promoted: boolean;
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
  private entrySeq = 0; // mints the stable per-entry snapshot handle (q<seq>)
  // The permits THIS replica's in-flight work holds — renewed on a heartbeat so the ledger's lease reap never
  // frees a permit out from under running compute. Membership: added on a successful tryAdmit, removed when
  // the permit is released (settle or queued-drop). The timer exists only while something holds a permit.
  private readonly livePermits = new Set<string>();
  private renewTimer: ReturnType<typeof setInterval> | undefined;

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

  dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
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
        id: `q${++this.entrySeq}`,
        job,
        enqueuedAt: (this.opts.now ?? Date.now)(),
        resolve,
        reject,
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(opts?.onStarted ? { onStarted: opts.onStarted } : {}),
        ...(opts?.onWaiting ? { onWaiting: opts.onWaiting } : {}),
        ...(opts?.onAttempt ? { onAttempt: opts.onAttempt } : {}),
        ...(opts?.onReserved ? { onReserved: opts.onReserved } : {}),
      };
      if (opts?.signal) {
        // Aborted while still QUEUED → remove and reject, so a cancelled job never wastes a placement slot. Once
        // in-flight this listener is detached (see pump) and cancellation flows to the backend via the signal instead.
        const onAbort = (): void => {
          if (this.queue.remove(entry)) {
            this.releaseBudget(job); // admitted-then-cancelled while queued → give the reserved run back
            this.releasePermit(entry);
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
  cancelQueued(predicate: (job: CaseJob) => boolean): number {
    let cancelled = 0;
    for (const entry of this.queue.ordered()) {
      if (!predicate(entry.job)) continue;
      this.queue.remove(entry);
      this.releaseBudget(entry.job); // superseded/speculation-loser while queued → refund its admit reservation
      this.releasePermit(entry);
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

  private eligibleNames(job: CaseJob): string[] {
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
  // Per-backend ISOLATION (arch-review 6, H7): one runtime's probe failure stops ONE runtime, not the fleet.
  // A tenant-registered K8s runtime with a revoked token (or kubectl missing on its lane) used to reject the
  // whole Promise.all, killing the drain — every OTHER backend's queue stalled behind one bad registration.
  // A failed probe now leaves that backend absent from the caps map: no capacity known → nothing placed on it
  // this pump (fail-closed for the one runtime; its jobs stay queued), everything else drains normally.
  private async probeCapacities(): Promise<Map<string, BackendCapacity>> {
    const caps = new Map<string, BackendCapacity>();
    await Promise.all(
      this.registry.names().map(async (name) => {
        try {
          caps.set(name, await this.registry.get(name).capacity());
        } catch {
          // absent from the map = no slots this pump — the queue keeps the jobs, the next pump re-probes
        }
      }),
    );
    return caps;
  }

  // Read the fleet's tenant in-flight once per drain. Best-effort by contract: a ledger that cannot answer (the
  // database is briefly unreachable) falls back to this process's own counts — the pre-ledger behavior — because
  // a scheduler that refuses to place anything while the ledger is down is a worse outage than a quota that is
  // momentarily per-replica again. Absent ledger = the same fallback, with no read at all.
  private async probeFleetInFlight(): Promise<FleetInFlight> {
    const atProbe = this.opts.ledger ? await this.opts.ledger.inFlightByTenant().catch(() => ({})) : {};
    return new FleetInFlight(atProbe, this.admission.snapshot().tenantInFlight);
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
      const fleet = await this.probeFleetInFlight(); // ONE ledger read per drain, on the same budget
      // Per-drain memo for harness-keyed capacity (capacityFor answers from the same probe snapshot, so one
      // reading per (backend, harness) is both cheap and coherent with `caps` above).
      const caseCaps = new Map<string, BackendCapacity | undefined>();
      while (placedAny && this.queue.size > 0) {
        placedAny = false;
        const slots = this.freeSlotsFrom(caps); // recompute from the snapshot + live in-flight (no HTTP)
        // Scan in the effective order (scanOrder — the same order queueEntries() reports), but skip jobs that
        // can't be sent now due to quota/capacity (HOL avoidance).
        const nowMs = (this.opts.now ?? Date.now)();
        for (const { entry } of this.scanOrder(nowMs)) {
          const tenant = tenantOf(entry.job);
          const quota = this.opts.tenantQuota?.(tenant) ?? Number.POSITIVE_INFINITY;
          // The snapshot check is the cheap PRE-FILTER (HOL avoidance — skip work that plainly has no
          // headroom without a write). It is NOT the limit: the atomic permit below is (tryAdmit, TRUST-07).
          if (fleet.countFor(tenant, this.admission.tenantCountFor(tenant)) >= quota) continue; // tenant quota reached

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

          // Harness-keyed capacity (CaseCapacityAware): among the slot-eligible backends keep only those where
          // THIS job's harness has pool room — one runtime carrying two service harnesses admits each by its
          // own pool, and a job whose pool is full is skipped (HOL avoidance) instead of dispatched into
          // case-by-case refusals.
          const withHarnessRoom: BackendSlot[] = [];
          for (const slot of candidates) {
            if (await this.harnessRoom(slot.name, entry.job, caseCaps)) withHarnessRoom.push(slot);
          }
          if (withHarnessRoom.length === 0) continue;

          const chosen = this.policy.choose(withHarnessRoom, entry.job);
          if (chosen === undefined) continue;

          // HARD quota (TRUST-07): the snapshot above is a stale read by construction — two replicas seeing
          // the same headroom in the same instant both pass it. The ATOMIC permit is the actual limit; a
          // refusal leaves the entry queued for the next drain. Fail-CLOSED on a ledger error: a quota is a
          // guarantee, and admitting on "could not check" is how a guarantee becomes a suggestion (the
          // pre-filter's own fallback still covers the no-quota and no-ledger wirings).
          if (Number.isFinite(quota) && this.opts.ledger?.tryAdmit) {
            entry.permitId ??= `${entry.id}-${crypto.randomUUID()}`; // globally unique — q<seq> collides across replicas
            const admitted = await this.opts.ledger.tryAdmit(tenant, entry.permitId, quota).catch(() => false);
            if (!admitted) continue; // quota held elsewhere in the fleet — try the next job
            this.holdPermit(entry.permitId);
          }

          // The COMMIT POINT. The awaits above (capacity probe, harness room, tryAdmit) leave the abort
          // listener attached, so an entry cancelled mid-await was already removed and rejected by onAbort —
          // and its permit released, though a claim whose commit outran the abort may land only now. remove()
          // answering false IS that cancellation: return the just-claimed permit and never dispatch. The
          // pre-fix pump ignored the boolean and dispatched the rejected entry anyway, saved only by every
          // backend refusing a pre-aborted signal — a convention carrying an invariant — while re-holding
          // (and renewing) a permit onAbort had already dropped.
          if (!this.queue.remove(entry)) {
            this.releasePermit(entry);
            continue;
          }
          // Leaving the queue → detach the queued-abort listener; from here cancellation rides the signal we hand
          // to backend.dispatch below (the backend stops its poll and reclaims the orchestrator job).
          if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
          const slot = slots.get(chosen);
          if (slot) {
            slot.free -= 1; // local decrement within the same pump pass
            slot.memFreeMb -= memNeed;
            slot.cpuFree -= cpuNeed;
          }
          this.admission.reserve(chosen, tenant, memNeed, cpuNeed, harnessKeyOf(entry.job));
          this.runOne(entry, chosen, tenant, memNeed, cpuNeed);
          placedAny = true;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  // Does THIS job's harness have room on the backend? Only CaseCapacityAware backends are asked; the answer is
  // memoized per drain (capacityFor reads the same probe snapshot the drain started with), and our OWN
  // per-harness placements are max'd in so a single drain cannot over-admit into one pool.
  private async harnessRoom(
    name: string,
    job: CaseJob,
    memo: Map<string, BackendCapacity | undefined>,
  ): Promise<boolean> {
    const backend = this.registry.get(name);
    if (!isCaseCapacityAware(backend)) return true;
    const harness = harnessKeyOf(job);
    const key = `${name}|${harness}`;
    if (!memo.has(key)) memo.set(key, await backend.capacityFor(job).catch(() => undefined));
    const cap = memo.get(key);
    if (!cap) return true; // no per-harness signal (not warm yet / no pool declared) → the aggregate decides
    const used = Math.max(cap.used, this.admission.harnessCountFor(name, harness));
    return cap.total - used > 0;
  }

  // The effective scan order — the fair (WFQ) order partitioned into the urgent class first (interactive /
  // operator-promoted / aged past agingMs; the tenant-fair order is preserved WITHIN each class) then the rest.
  // AGING: an entry waiting past agingMs joins the urgent class regardless of its own priority — an interactive
  // flood must not starve batch work forever. pump() places in this order and queueEntries() reports it, so what
  // the queue page shows IS what the scheduler will try next.
  private scanOrder(nowMs: number): Array<{ entry: QueueEntry; urgent: boolean }> {
    const agingMs = this.opts.agingMs ?? 60_000;
    const isUrgent = (e: QueueEntry): boolean =>
      e.job.priority === "interactive" || e.promoted === true || nowMs - e.enqueuedAt >= agingMs;
    const ordered = this.queue.ordered();
    return [
      ...ordered.filter(isUrgent).map((entry) => ({ entry, urgent: true })),
      ...ordered.filter((e) => !isUrgent(e)).map((entry) => ({ entry, urgent: false })),
    ];
  }

  // The scheduler's OWN wait queue, in the effective scan order — the observable half of pump(). This is the
  // real control queue (WFQ entries), not the record-status projection the /queue lanes are built from; the
  // caller (QueueService) filters by tenant before anything leaves the control plane.
  queueEntries(): SchedulerQueueEntry[] {
    const nowMs = (this.opts.now ?? Date.now)();
    return this.scanOrder(nowMs).map(({ entry, urgent }) => ({
      id: entry.id,
      tenant: tenantOf(entry.job),
      caseId: entry.job.evalCase.id,
      ...(entry.job.runId !== undefined ? { runId: entry.job.runId } : {}),
      ...(entry.job.batchId !== undefined ? { batchId: entry.job.batchId } : {}),
      harness: { id: entry.job.harness.id, version: entry.job.harness.version },
      ...(entry.job.evalCase.placement?.target !== undefined ? { target: entry.job.evalCase.placement.target } : {}),
      ...(entry.job.priority !== undefined ? { priority: entry.job.priority } : {}),
      ...(entry.job.evalCase.tags !== undefined && entry.job.evalCase.tags.length > 0
        ? { tags: entry.job.evalCase.tags }
        : {}),
      enqueuedAt: entry.enqueuedAt,
      urgent,
      promoted: entry.promoted === true,
    }));
  }

  // Cancel ONE queued entry by its snapshot id — the queue page's kill switch (e.g. a stray judge job from a
  // reclaimed batch). Same settlement as cancelQueued: refund the admit reservation and reject with CANCELLED,
  // so the dispatch caller's existing retry/settle machinery classifies it. In-flight work is untouched
  // (reclaiming that is Backend.kill's job). Returns false when the id is not queued (already placed/settled).
  cancelEntry(id: string): boolean {
    const entry = this.queue.ordered().find((e) => e.id === id);
    if (!entry) return false;
    this.queue.remove(entry);
    if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
    this.releaseBudget(entry.job);
    this.releasePermit(entry);
    entry.reject(new InternalError("CANCELLED", { caseId: entry.job.evalCase.id }, "cancelled from the queue."));
    return true;
  }

  // Move ONE queued entry to the front of the effective order (operator "run this next"): urgent class + the
  // fair-order head. Fairness bookkeeping is untouched — promotion reorders what already waits, it grants no
  // credit for future enqueues. Returns false when the id is not queued.
  promoteEntry(id: string): boolean {
    const entry = this.queue.ordered().find((e) => e.id === id);
    if (!entry) return false;
    entry.promoted = true;
    this.queue.promote(entry);
    void this.pump(); // a freed slot may already be waiting for it
    return true;
  }

  // Give back a queued job's admit reservation when it leaves the queue WITHOUT being dispatched (abort / supersede /
  // placement failure); a dispatched job that later fails still ran, so it is NOT released here.
  private releaseBudget(job: CaseJob): void {
    this.opts.budget?.release(tenantOf(job));
  }

  // Return an entry's fleet-wide permit when it leaves the queue WITHOUT being dispatched. A queued entry
  // normally holds none — but a tryAdmit whose claim committed while the response was lost leaves a REAL permit
  // behind the refusal the scheduler saw, and dropping the entry without this held that tenant slot until the
  // reap. Releasing a never-admitted permit id is a ledger no-op, so this is safe on every drop path.
  private releasePermit(entry: QueueEntry): void {
    if (!entry.permitId) return;
    this.dropPermit(entry.permitId);
    void this.opts.ledger?.releaseAdmission?.(entry.permitId)?.catch?.(() => {});
  }

  // ── The permit-lease heartbeat ── while this replica holds any permit, renew them all on an interval well
  // inside the ledger's lease window, so the reap frees only permits whose holder STOPPED RENEWING — death,
  // or a ledger partition the reap cannot distinguish from it (a partitioned-but-alive holder's compute can
  // briefly exceed the quota; see AdmissionLedger). The timer lives only while permits are held and never
  // pins the process.
  private holdPermit(permitId: string): void {
    this.livePermits.add(permitId);
    if (this.renewTimer !== undefined || this.opts.ledger?.renewAdmissions === undefined) return;
    const timer = setInterval(() => {
      if (this.livePermits.size === 0) return;
      void this.opts.ledger?.renewAdmissions?.([...this.livePermits])?.catch?.(() => {});
    }, this.opts.permitRenewMs ?? 600_000);
    timer.unref?.();
    this.renewTimer = timer;
  }

  private dropPermit(permitId: string): void {
    this.livePermits.delete(permitId);
    if (this.livePermits.size === 0 && this.renewTimer !== undefined) {
      clearInterval(this.renewTimer);
      this.renewTimer = undefined;
    }
  }

  private runOne(entry: QueueEntry, name: string, tenant: string, memNeedMb: number, cpuNeed: number): void {
    // The entry just left the wait queue → forward signal (cancellation) AND onStarted (the "compute is beginning"
    // hook). A managed backend fires onStarted at its dispatch entry (= now, post-admission); the self-hosted backend
    // forwards it to the lease hub so it fires only when a runner actually takes the job.
    const dispatchOpts =
      entry.signal || entry.onStarted || entry.onWaiting || entry.onAttempt || entry.onReserved
        ? {
            ...(entry.signal ? { signal: entry.signal } : {}),
            ...(entry.onStarted ? { onStarted: entry.onStarted } : {}),
            // onWaiting rides along too (live-caught: the Scheduler used to DROP it, so a managed lane's
            // blocked-placement verdict never reached the caller's step/fact seam).
            ...(entry.onWaiting ? { onWaiting: entry.onWaiting } : {}),
            // …and onAttempt, for the same reason: this whitelist is the ONE place a hook can silently die,
            // and dropping this one would leave the caller sealing the attempt a requeue abandoned.
            ...(entry.onAttempt ? { onAttempt: entry.onAttempt } : {}),
            // …and onReserved. Dropping this one costs the caller the only handle to the compute it is about to start:
            // the teardown then falls back to the case id, which is another run's job too (arch-review 52).
            ...(entry.onReserved ? { onReserved: entry.onReserved } : {}),
          }
        : undefined;
    this.registry
      .get(name)
      .dispatch(entry.job, dispatchOpts)
      .then((result) => {
        this.opts.budget?.settle(tenant, costOf(result)); // commit the actual cost on completion
        entry.resolve(result);
      }, entry.reject)
      .finally(() => {
        this.admission.release(name, tenant, memNeedMb, cpuNeed, harnessKeyOf(entry.job));
        // Return the fleet-wide permit (idempotent; a failed release stops renewing, so the lease reap heals it).
        if (entry.permitId) {
          this.dropPermit(entry.permitId);
          void this.opts.ledger?.releaseAdmission?.(entry.permitId)?.catch?.(() => {});
        }
        void this.pump();
      });
  }
}
