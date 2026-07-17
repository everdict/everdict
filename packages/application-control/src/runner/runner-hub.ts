import { randomUUID } from "node:crypto";
import { type AgentJob, type CaseResult, RateLimitError, UpstreamError } from "@everdict/contracts";
import { capabilityKind, requiredCapabilitiesForJob } from "@everdict/domain";

// Self-hosted runner dispatch key — the identity of the runner a job will flow to. The lease queue is keyed by (owner, runnerId) (D3).
// ⚠️ The workspace (tenant) is NOT part of the key — a runner receives jobs from all of its owner's workspaces on a single queue
// (cross-workspace). The job carries its own tenant, so results are recorded against the correct workspace.
export interface SelfHostedKey {
  owner: string; // runner owner = principal.subject
  runnerId: string;
}

// Pool sentinel — a runnerId of this value means "not a specific runner but the owner's pool". A job submitted as
// self:ws (with no runner id) is parked under this key, and any of that owner's runners (that satisfy the capabilities)
// leases it (N runners drain one pool). This string is never used as an individual runner id (runner pairing ids are UUIDs) — no collision.
export const POOL_RUNNER = "*";
export function poolKeyFor(owner: string): SelfHostedKey {
  return { owner, runnerId: POOL_RUNNER };
}

export function selfHostedBackendName(key: SelfHostedKey): string {
  return `self:${key.owner}:${key.runnerId}`;
}

// What the placement gate looks at = the **functional** capabilities the job requires (rejected if the runner can't advertise them).
// The full job requirement set (case caps ∪ topology docker/OS) is the shared requiredCapabilitiesForJob; here we keep
// only the functional subset — security(sandbox)/auth(login) are enforced by their own layers (trust-zone/budget), not
// placement. So a service (topology) harness needs docker, and a Windows service needs os-windows (a Linux runner that
// doesn't advertise it is correctly skipped; a Linux topology adds no OS cap → unaffected).
// Design: docs/architecture/self-hosted-runtime-and-runners.md · heterogeneous-topology-placement.md (placement gate).
export function requiredRunnerCapabilities(job: AgentJob): string[] {
  return requiredCapabilitiesForJob(job).filter((c) => capabilityKind(c) === "functional");
}

// A single job the runner leases (the core of the MCP lease_job response).
export interface LeasedJob {
  jobId: string;
  job: AgentJob;
}

// enqueue result — the job result + the id of the runner that actually completed it (ranBy). For a pool (self:ws) job we don't
// know at park time which runner will take it, so we return the completing runner's id here (the backend stamps it as provenance.runner). Same for a specific-runner job.
export interface EnqueueResult {
  result: CaseResult;
  ranBy: string; // runnerId of the runner that ran/reported back
}

interface PendingEntry {
  jobId: string;
  job: AgentJob;
  resolve: (r: EnqueueResult) => void;
  reject: (e: Error) => void;
  // Fired once when a runner first LEASES this job (undefined→leasedAt). Lets the dispatch caller flip the run record
  // queued→running the moment it actually starts executing (not at park). Best-effort — a throw must not break lease.
  onLease?: () => void;
  onLeaseFired?: boolean;
  leasedAt?: number; // time the runner took it (undefined = waiting). Slice 6's expiry/requeue looks at this.
  // The control plane asked to stop this job (user cancel / supersede). Its promise is already rejected; the entry
  // lingers ONLY so the runner's next heartbeat is told to abort (freeing the runtime). Never leasable/requeuable.
  cancelRequested?: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export interface RunnerHubDeps {
  // Max time a job may hang with no 'activity' (lease/heartbeat) — lease/heartbeat resets it.
  // A long-running job on an actively-heartbeating runner stays alive indefinitely; only jobs on unconnected/idle/dead runners are rejected after this time.
  queueTimeoutMs?: number;
  // If this much time passes after a runner leases a job with no complete/heartbeat, requeue it (runner died / network cut → another/reconnected runner takes it).
  leaseTtlMs?: number;
  // Backpressure (Phase 2): the max number of WAITING (un-leased) jobs a single runner/pool queue may hold. A park
  // that would exceed it is rejected with RateLimitError(429) at dispatch instead of growing the queue without bound
  // (self-hosted jobs bypass the Scheduler's queue-depth cap — this is its self-hosted analogue). 0/undefined = unlimited.
  maxWaitingPerKey?: number;
  newJobId?: () => string;
  now?: () => number;
}

// In-memory lease hub for personally-owned self-hosted runners — the heart of push→pull.
// SelfHostedBackend.dispatch parks a job here (returning a promise), and the runner protocol (MCP, Slice 4)
// resolves that promise via lease (take) / complete (report result). FIFO queue per key (= per runner).
// Design: docs/architecture/self-hosted-runner.md.
export class RunnerHub {
  private readonly queues = new Map<string, PendingEntry[]>();
  private readonly waiters = new Map<string, Array<() => void>>(); // long-poll lease waiters (per-key wake callbacks)
  private readonly wakeCursor = new Map<string, number>(); // per-owner round-robin cursor (pool wake fairness)
  // Lease FAIRNESS (Phase 2): a monotonic tick bumped on every lease + the tick each (queue, group) was last served.
  // "group" = batchId ?? submitter ?? tenant → a runner shared by many users/batches rotates across them (WFQ-lite)
  // instead of draining one 601-case batch before the next user's 3-case run. Priority (interactive) still dominates.
  private serveTick = 0;
  private readonly groupLastServed = new Map<string, number>();
  private readonly queueTimeoutMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxWaitingPerKey: number;
  private readonly newJobId: () => string;
  private readonly now: () => number;
  constructor(deps: RunnerHubDeps = {}) {
    this.queueTimeoutMs = deps.queueTimeoutMs ?? 300_000; // default 5 minutes
    this.leaseTtlMs = deps.leaseTtlMs ?? 120_000; // default 2 minutes (renewed by heartbeat)
    this.maxWaitingPerKey = deps.maxWaitingPerKey ?? 0; // 0 = unlimited (backpressure opt-in)
    this.newJobId = deps.newJobId ?? randomUUID;
    this.now = deps.now ?? Date.now;
  }

  private q(key: SelfHostedKey): PendingEntry[] {
    const k = selfHostedBackendName(key);
    let arr = this.queues.get(k);
    if (!arr) {
      arr = [];
      this.queues.set(k, arr);
    }
    return arr;
  }

  // Park a job and return the result promise (SelfHostedBackend.dispatch). Resolves when a runner completes it;
  // rejects if queueTimeoutMs passes with no 'activity' (lease/heartbeat) (unconnected/idle). FIFO per key.
  // onLease (optional) fires once when a runner first takes the job → the caller flips the run record queued→running.
  enqueue(key: SelfHostedKey, job: AgentJob, onLease?: () => void): Promise<EnqueueResult> {
    const jobId = this.newJobId();
    const arr = this.q(key);
    // Backpressure: a self-hosted job bypasses the Scheduler's queue-depth cap, so bound the lease queue here. Over
    // the cap ⇒ explicit RateLimitError(429), never a silent unbounded pile-up. Counts only WAITING (un-leased) jobs.
    if (this.maxWaitingPerKey > 0) {
      const waiting = arr.filter((e) => e.leasedAt === undefined && !e.cancelRequested).length;
      if (waiting >= this.maxWaitingPerKey)
        return Promise.reject(
          new RateLimitError(
            "RATE_LIMITED",
            { runnerId: key.runnerId, waiting, limit: this.maxWaitingPerKey },
            `This runner's queue is full (${waiting}/${this.maxWaitingPerKey} waiting) — wait for it to drain, add another runner, or raise EVERDICT_RUNNER_MAX_QUEUE.`,
          ),
        );
    }
    // The executor runs synchronously, so resolve/reject are reassigned immediately (the no-op initial values are for the no-`!` discipline).
    let resolve: (r: EnqueueResult) => void = () => {};
    let reject: (e: Error) => void = () => {};
    const promise = new Promise<EnqueueResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: PendingEntry = {
      jobId,
      job,
      resolve,
      reject,
      ...(onLease ? { onLease } : {}),
      timer: this.armTimeout(key, jobId, reject),
    };
    arr.push(entry);
    // Wake a runner that is long-poll waiting (single-threaded → inside wake, lease immediately takes this job).
    if (key.runnerId === POOL_RUNNER)
      this.wakeOwner(key.owner); // pool job → wake that owner's polling runners so their lease scans the pool queue
    else this.waiters.get(selfHostedBackendName(key))?.shift()?.();
    return promise;
  }

  // When a job lands in an owner's pool, wake that owner's long-poll-waiting runners (each one's lease checks the pool queue → one takes it).
  // ⚠️ Fairness: single-threaded, so the runner woken "first" takes the job (later runners re-wait with null). Always waking in the same order
  // lets one runner monopolize the pool (worse the faster jobs complete) → round-robin rotates the start runner to spread evenly across N runners.
  private wakeOwner(owner: string): void {
    const prefix = `self:${owner}:`;
    const poolName = selfHostedBackendName(poolKeyFor(owner));
    const keys = [...this.waiters.keys()].filter(
      (k) => k.startsWith(prefix) && k !== poolName && (this.waiters.get(k)?.length ?? 0) > 0,
    );
    if (keys.length === 0) return;
    keys.sort(); // deterministic order + rotation offset → a different runner goes first for each job (fair)
    const cur = this.wakeCursor.get(owner) ?? 0;
    this.wakeCursor.set(owner, cur + 1);
    const start = cur % keys.length;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[(start + i) % keys.length];
      if (k !== undefined) this.waiters.get(k)?.shift()?.();
    }
  }

  // The 'idle timeout' timer — reject the job if there's no activity (lease/heartbeat) for queueTimeoutMs.
  // lease/heartbeat resets this timer, so a long-running job on an actively-heartbeating runner (codex/claude-code etc.,
  // minutes to tens of minutes) is never wrongly rejected. If no runner takes it (unconnected/idle), or a runner takes it and then dies so
  // its heartbeat stops, it is rejected as no_runner after this time.
  private armTimeout(key: SelfHostedKey, jobId: string, reject: (e: Error) => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.remove(key, jobId);
      // If the reject is swallowed somewhere it looks like a "silent failure for no reason" — surface the cause (unconnected/idle) and elapsed time in the server log.
      console.warn(
        `[runner-hub] idle timeout: runner ${selfHostedBackendName(key)} had no activity (lease/heartbeat) on job ${jobId} for ${this.queueTimeoutMs}ms — treating as unconnected/idle.`,
      );
      reject(
        new UpstreamError(
          "UPSTREAM_ERROR",
          { runnerId: key.runnerId, reason: "no_runner" },
          "No self-hosted runner activity — the runner is not connected, is idle/dead, or (if the control plane runs " +
            "multiple replicas) it is attached to a different replica than the one holding this job. Check the runner is " +
            "online; for a multi-replica deployment, pin self-hosted dispatch to one replica (the lease hub is in-process).",
        ),
      );
    }, this.queueTimeoutMs);
    // Don't let the timer hold the process open (test/shutdown friendly). Non-Node runtimes have no unref → optional chaining.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  // Reset the idle timeout on activity (lease take or heartbeat). Swaps out the existing timer.
  private rearm(key: SelfHostedKey, entry: PendingEntry): void {
    clearTimeout(entry.timer);
    entry.timer = this.armTimeout(key, entry.jobId, entry.reject);
  }

  // Fire the entry's onLease hook exactly once (first lease). Best-effort — a throw in the caller's callback must not
  // break the lease (the job still runs; only the queued→running record flip is missed). A requeue+re-lease won't
  // re-fire (the flag stays set); the run is already running so there's nothing to re-flip anyway.
  private fireOnLease(entry: PendingEntry): void {
    if (entry.onLeaseFired || !entry.onLease) return;
    entry.onLeaseFired = true;
    try {
      entry.onLease();
    } catch (e) {
      console.warn(`[runner-hub] onLease hook threw for job ${entry.jobId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // The fairness group a job belongs to on a shared runner: its batch (scorecard fan-out), else its submitter
  // (interactive single runs / different users), else its tenant. One giant batch = one group, so it can't crowd out
  // the next user's small run — the lease rotates across groups.
  private static groupKeyOf(job: AgentJob): string {
    if (job.batchId) return `b:${job.batchId}`;
    if (job.submittedBy) return `u:${job.submittedBy}`;
    return `t:${job.tenant ?? ""}`;
  }

  // Un-leased, non-cancelled entries in the order a runner should take them: (1) interactive before batch (a person is
  // waiting — same rule the managed Scheduler applies), then (2) the least-recently-served group first (WFQ-lite fair
  // rotation across batches/users), then (3) FIFO within a group (stable by enqueue index). Pure read — leasing an
  // entry (markServed) is what advances the rotation.
  private orderLeasable(queueName: string, arr: PendingEntry[]): PendingEntry[] {
    const prio = (e: PendingEntry): number => (e.job.priority === "interactive" ? 0 : 1);
    const lastServed = (e: PendingEntry): number =>
      this.groupLastServed.get(`${queueName} ${RunnerHub.groupKeyOf(e.job)}`) ?? -1;
    return arr
      .map((entry, index) => ({ entry, index }))
      .filter((x) => x.entry.leasedAt === undefined && !x.entry.cancelRequested)
      .sort((a, b) => {
        const dp = prio(a.entry) - prio(b.entry);
        if (dp !== 0) return dp;
        const dg = lastServed(a.entry) - lastServed(b.entry);
        if (dg !== 0) return dg;
        return a.index - b.index; // FIFO within a group
      })
      .map((x) => x.entry);
  }

  // Record that this queue just served the entry's group → the next lease prefers a different group (round-robin).
  private markServed(queueName: string, entry: PendingEntry): void {
    this.groupLastServed.set(`${queueName} ${RunnerHub.groupKeyOf(entry.job)}`, ++this.serveTick);
  }

  // Take the next un-leased job (runner pull). None → null (the runner re-polls). Records leasedAt.
  // First requeues expired leases (runner dead/disconnected) — so another/reconnected runner can take them again.
  // If capabilities are given (runner self-advertised) this is a placement gate: if the runner lacks a capability the job requires
  // (case.image→docker), fail that job immediately — reject with a clear reason instead of running in the wrong environment (host fallback), avoiding a silent idle timeout.
  lease(key: SelfHostedKey, capabilities?: string[]): LeasedJob | null {
    const arr = this.q(key);
    const now = this.now();
    this.requeueExpired(arr, now);
    // 1) Own queue (jobs targeted at a specific runner) — on capability mismatch, reject immediately (this runner was
    //    explicitly named, so avoid the wrong environment). Entries are considered in fairness order (priority → WFQ
    //    across groups → FIFO), not raw arrival, so one big batch can't monopolize a runner shared by several users.
    const ownName = selfHostedBackendName(key);
    for (const entry of this.orderLeasable(ownName, arr)) {
      if (entry.leasedAt !== undefined) continue; // a rejection below could have removed/settled an earlier pick
      const missing = capabilities
        ? requiredRunnerCapabilities(entry.job).filter((c) => !capabilities.includes(c))
        : [];
      if (missing.length > 0) {
        this.remove(key, entry.jobId);
        clearTimeout(entry.timer);
        console.warn(
          `[runner-hub] capability mismatch: runner ${selfHostedBackendName(key)} lacks [${missing.join(",")}] — rejecting job ${entry.jobId}.`,
        );
        entry.reject(
          new UpstreamError(
            "UPSTREAM_ERROR",
            { runnerId: key.runnerId, reason: "capability_mismatch", missing },
            `The runner lacks the capabilities [${missing.join(", ")}] this job requires — rejecting to avoid the wrong environment (host fallback).`,
          ),
        );
        continue; // try the next job (in fairness order)
      }
      entry.leasedAt = now;
      this.markServed(ownName, entry); // advance the group rotation so the next lease prefers a different batch/user
      this.fireOnLease(entry); // first lease → flip the run record queued→running (the case actually started)
      this.rearm(key, entry); // runner took it → reset idle timeout (heartbeat now keeps it alive)
      this.touchByRunner(key); // taking a job proves the runner is alive → keep the jobs queued behind it from expiring
      return { jobId: entry.jobId, job: entry.job };
    }
    // 2) Owner pool queue (jobs submitted as self:ws, no specific runner) — on capability mismatch **skip, don't reject**
    //    (so another capable runner can take it). If nobody can, the idle timeout eventually rejects it. A pool job stays in the pool queue
    //    with only leasedAt marked (on runner death the requeue happens naturally within the pool so another runner re-acquires it).
    if (key.runnerId === POOL_RUNNER) return null; // the pool key itself doesn't self-lease (prevents infinite recursion)
    const poolKey = poolKeyFor(key.owner);
    const poolArr = this.q(poolKey);
    this.requeueExpired(poolArr, now);
    const poolName = selfHostedBackendName(poolKey);
    for (const entry of this.orderLeasable(poolName, poolArr)) {
      const missing = capabilities
        ? requiredRunnerCapabilities(entry.job).filter((c) => !capabilities.includes(c))
        : [];
      if (missing.length > 0) continue; // this runner can't run it → skip and leave it for another runner (not a rejection)
      entry.leasedAt = now;
      this.markServed(poolName, entry); // advance the group rotation within the pool too
      this.fireOnLease(entry); // first lease → flip the run record queued→running (the case actually started)
      this.rearm(poolKey, entry); // the timer is keyed to the pool queue (so remove finds it in the pool)
      this.touchByRunner(key); // draining one pool job proves the runner is alive → keep the rest of the pool from expiring
      return { jobId: entry.jobId, job: entry.job };
    }
    return null;
  }

  // Requeue expired leases (runner dead/disconnected) — clear leasedAt to make them leasable again. Shared by the own queue and the pool queue.
  private requeueExpired(arr: PendingEntry[], now: number): void {
    for (const e of arr) {
      // A cancelled entry is never requeued (it's on its way out — the runner is being told to abort it).
      if (e.leasedAt !== undefined && !e.cancelRequested && now - e.leasedAt > this.leaseTtlMs) e.leasedAt = undefined;
    }
  }

  // Find jobId in the own queue first, else in the owner pool queue (a pool job lives in the pool queue and the runner completes/heartbeats with its own key).
  private locate(key: SelfHostedKey, jobId: string): { entry: PendingEntry; key: SelfHostedKey } | undefined {
    const own = this.q(key).find((e) => e.jobId === jobId);
    if (own) return { entry: own, key };
    if (key.runnerId !== POOL_RUNNER) {
      const poolKey = poolKeyFor(key.owner);
      const pooled = this.q(poolKey).find((e) => e.jobId === jobId);
      if (pooled) return { entry: pooled, key: poolKey };
    }
    return undefined;
  }

  // long-poll lease — if there's no job to take immediately, wait until the next enqueue (or the waitMs timeout) then return one (null if none).
  // Keeps runners from re-polling in a tight loop (the server holds the request until a job appears).
  leaseWait(key: SelfHostedKey, waitMs: number, capabilities?: string[]): Promise<LeasedJob | null> {
    const immediate = this.lease(key, capabilities);
    if (immediate || waitMs <= 0) return Promise.resolve(immediate);
    const k = selfHostedBackendName(key);
    return new Promise<LeasedJob | null>((resolve) => {
      let done = false;
      const finish = (v: LeasedJob | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const a = this.waiters.get(k);
        const i = a?.indexOf(wake) ?? -1;
        if (a && i >= 0) a.splice(i, 1);
        resolve(v);
      };
      const wake = () => finish(this.lease(key, capabilities)); // enqueue wakes us → immediately lease that job (gate included)
      const timer = setTimeout(() => finish(null), waitMs);
      (timer as { unref?: () => void }).unref?.();
      const arr = this.waiters.get(k) ?? [];
      arr.push(wake);
      this.waiters.set(k, arr);
    });
  }

  // Runner liveness signal — renew the lease (update leasedAt) so a long-running job isn't requeued. It also carries
  // the control plane's cancel decision back to the runner: `cancelled` = stop this job now (→ the runner aborts the
  // local run, freeing the runtime mid-case). `extended` is false if the job isn't in a queue (own/pool).
  heartbeat(key: SelfHostedKey, jobId: string): { extended: boolean; cancelled: boolean } {
    // A heartbeat is proof the runner is alive — refresh the idle timeout of everything else it could still take too
    // (a maxConcurrent=1 runner heartbeats only the job it is running; the jobs queued behind it must not expire meanwhile).
    this.touchByRunner(key);
    const loc = this.locate(key, jobId);
    if (!loc) return { extended: false, cancelled: false };
    loc.entry.leasedAt = this.now();
    this.rearm(loc.key, loc.entry); // liveness signal → reset idle timeout (so a long-running job isn't wrongly rejected)
    return { extended: true, cancelled: loc.entry.cancelRequested === true };
  }

  // Cancel matching in-flight/parked jobs (a user stopped the scorecard, or supersede reclaimed it). The parked/leased
  // promise is rejected NOW so the batch settles without waiting on the runner (cooperative — a cancelled case becomes
  // an interrupted failure in the partial). The entry lingers (marked cancelRequested → neither leasable nor requeuable)
  // ONLY so the runner's next heartbeat returns cancelled and it aborts the local run + frees the runtime; the runner's
  // submit (or the idle timeout) then removes it. Returns how many jobs were signalled. Single-process, best-effort —
  // the same assumption as the lease hub itself. Predicate keys on the job (e.g. j.batchId === scorecardId).
  requestCancel(predicate: (job: AgentJob) => boolean): number {
    let count = 0;
    for (const arr of this.queues.values()) {
      for (const entry of arr) {
        if (entry.cancelRequested || !predicate(entry.job)) continue;
        entry.cancelRequested = true;
        entry.reject(
          new UpstreamError(
            "UPSTREAM_ERROR",
            { jobId: entry.jobId, reason: "cancelled" },
            "Run cancelled — the scorecard was stopped.",
          ),
        );
        count++;
      }
    }
    return count;
  }

  // Proof-of-life fan-out — a heartbeat, or a lease that actually TAKES a job, proves the owner has a LIVE runner doing
  // work, so it keeps alive not just the touched job but every un-leased job that runner could still take (its own queue +
  // the owner pool). Without this, a busy maxConcurrent=1 runner draining a scorecard serially lets the jobs queued behind
  // the running one hit the idle timeout and get wrongly rejected as "no runner connected" while the runner is alive and
  // working. Deliberately NOT called on an empty/skip poll: an idle runner that keeps skipping a job it can't run (e.g. a
  // non-docker runner passing over an image job in the pool) must not refresh that job forever — it still times out so an
  // unsatisfiable job fails instead of hanging. Leased jobs are left untouched — each is kept alive by its own heartbeat,
  // so a genuinely dead runner's in-flight job still expires.
  private touchByRunner(key: SelfHostedKey): void {
    this.rearmWaiting(key, this.q(key));
    if (key.runnerId !== POOL_RUNNER) {
      const poolKey = poolKeyFor(key.owner);
      this.rearmWaiting(poolKey, this.q(poolKey));
    }
  }

  private rearmWaiting(key: SelfHostedKey, arr: PendingEntry[]): void {
    for (const e of arr) if (e.leasedAt === undefined && !e.cancelRequested) this.rearm(key, e);
  }

  // Runner reports a result → resolve the parked promise. false if not in a queue (own/pool) (already completed/expired/unknown).
  complete(key: SelfHostedKey, jobId: string, result: CaseResult): boolean {
    const loc = this.locate(key, jobId);
    if (!loc) return false;
    this.remove(loc.key, jobId);
    clearTimeout(loc.entry.timer);
    // ranBy = the real id of the runner that called complete (key.runnerId). For a pool job this is the real runner, not "*" (the pool key).
    loc.entry.resolve({ result, ranBy: key.runnerId });
    return true;
  }

  // Runner reports a job failure → reject the promise (remapped to our error). false if not in a queue (own/pool).
  fail(key: SelfHostedKey, jobId: string, message: string): boolean {
    const loc = this.locate(key, jobId);
    if (!loc) return false;
    this.remove(loc.key, jobId);
    clearTimeout(loc.entry.timer);
    loc.entry.reject(new UpstreamError("UPSTREAM_ERROR", { runnerId: key.runnerId, jobId }, message));
    return true;
  }

  // Number of waiting/leased jobs (for capacity/observability).
  pending(key: SelfHostedKey): number {
    return this.q(key).length;
  }

  private remove(key: SelfHostedKey, jobId: string): PendingEntry | undefined {
    const arr = this.q(key);
    const i = arr.findIndex((e) => e.jobId === jobId);
    if (i < 0) return undefined;
    return arr.splice(i, 1)[0];
  }
}
