import { randomUUID } from "node:crypto";
import { type AgentJob, type CaseResult, UpstreamError, capabilityKind, requiredCapabilities } from "@everdict/core";

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
// Derived from the case (@everdict/core requiredCapabilities): image→docker · repo-git→git · browser→browser · os-use→computer-use.
// security(sandbox)/auth(login) are enforced by their own layers (trust-zone/budget), not placement, so here we only look at functional.
// Leasing an image-required job to a runner without Docker would run it in the wrong environment via host-native fallback → reject explicitly.
// Design: docs/architecture/self-hosted-runtime-and-runners.md · portable-harness-runtime.md (placement gate).
export function requiredRunnerCapabilities(job: AgentJob): string[] {
  const caps = requiredCapabilities(job.evalCase).filter((c) => capabilityKind(c) === "functional");
  // A service (topology) harness stands up a local Docker topology, so it needs docker (even if the case has no image) — the pool lease gate
  // uses this to skip non-docker runners and route to a docker runner. The specific-runner path is rejected earlier with BadRequest by the dispatcher.
  if (job.harnessSpec?.kind === "service" && !caps.includes("docker")) caps.push("docker");
  return caps;
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
  leasedAt?: number; // time the runner took it (undefined = waiting). Slice 6's expiry/requeue looks at this.
  timer: ReturnType<typeof setTimeout>;
}

export interface RunnerHubDeps {
  // Max time a job may hang with no 'activity' (lease/heartbeat) — lease/heartbeat resets it.
  // A long-running job on an actively-heartbeating runner stays alive indefinitely; only jobs on unconnected/idle/dead runners are rejected after this time.
  queueTimeoutMs?: number;
  // If this much time passes after a runner leases a job with no complete/heartbeat, requeue it (runner died / network cut → another/reconnected runner takes it).
  leaseTtlMs?: number;
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
  private readonly queueTimeoutMs: number;
  private readonly leaseTtlMs: number;
  private readonly newJobId: () => string;
  private readonly now: () => number;
  constructor(deps: RunnerHubDeps = {}) {
    this.queueTimeoutMs = deps.queueTimeoutMs ?? 300_000; // default 5 minutes
    this.leaseTtlMs = deps.leaseTtlMs ?? 120_000; // default 2 minutes (renewed by heartbeat)
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
  enqueue(key: SelfHostedKey, job: AgentJob): Promise<EnqueueResult> {
    const jobId = this.newJobId();
    const arr = this.q(key);
    // The executor runs synchronously, so resolve/reject are reassigned immediately (the no-op initial values are for the no-`!` discipline).
    let resolve: (r: EnqueueResult) => void = () => {};
    let reject: (e: Error) => void = () => {};
    const promise = new Promise<EnqueueResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: PendingEntry = { jobId, job, resolve, reject, timer: this.armTimeout(key, jobId, reject) };
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
          "No self-hosted runner activity — no runner is connected, or it is idle/dead.",
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

  // Take the next un-leased job (runner pull). None → null (the runner re-polls). Records leasedAt.
  // First requeues expired leases (runner dead/disconnected) — so another/reconnected runner can take them again.
  // If capabilities are given (runner self-advertised) this is a placement gate: if the runner lacks a capability the job requires
  // (case.image→docker), fail that job immediately — reject with a clear reason instead of running in the wrong environment (host fallback), avoiding a silent idle timeout.
  lease(key: SelfHostedKey, capabilities?: string[]): LeasedJob | null {
    const arr = this.q(key);
    const now = this.now();
    this.requeueExpired(arr, now);
    // 1) Own queue (jobs targeted at a specific runner) — on capability mismatch, reject immediately (this runner was explicitly named, so avoid the wrong environment).
    for (;;) {
      const entry = arr.find((e) => e.leasedAt === undefined);
      if (!entry) break;
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
        continue; // try the next job
      }
      entry.leasedAt = now;
      this.rearm(key, entry); // runner took it → reset idle timeout (heartbeat now keeps it alive)
      return { jobId: entry.jobId, job: entry.job };
    }
    // 2) Owner pool queue (jobs submitted as self:ws, no specific runner) — on capability mismatch **skip, don't reject**
    //    (so another capable runner can take it). If nobody can, the idle timeout eventually rejects it. A pool job stays in the pool queue
    //    with only leasedAt marked (on runner death the requeue happens naturally within the pool so another runner re-acquires it).
    if (key.runnerId === POOL_RUNNER) return null; // the pool key itself doesn't self-lease (prevents infinite recursion)
    const poolKey = poolKeyFor(key.owner);
    const poolArr = this.q(poolKey);
    this.requeueExpired(poolArr, now);
    for (const entry of poolArr) {
      if (entry.leasedAt !== undefined) continue;
      const missing = capabilities
        ? requiredRunnerCapabilities(entry.job).filter((c) => !capabilities.includes(c))
        : [];
      if (missing.length > 0) continue; // this runner can't run it → skip and leave it for another runner (not a rejection)
      entry.leasedAt = now;
      this.rearm(poolKey, entry); // the timer is keyed to the pool queue (so remove finds it in the pool)
      return { jobId: entry.jobId, job: entry.job };
    }
    return null;
  }

  // Requeue expired leases (runner dead/disconnected) — clear leasedAt to make them leasable again. Shared by the own queue and the pool queue.
  private requeueExpired(arr: PendingEntry[], now: number): void {
    for (const e of arr) {
      if (e.leasedAt !== undefined && now - e.leasedAt > this.leaseTtlMs) e.leasedAt = undefined;
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

  // Runner liveness signal — renew the lease (update leasedAt) so a long-running job isn't requeued. false if not in a queue (own/pool).
  heartbeat(key: SelfHostedKey, jobId: string): boolean {
    const loc = this.locate(key, jobId);
    if (!loc) return false;
    loc.entry.leasedAt = this.now();
    this.rearm(loc.key, loc.entry); // liveness signal → reset idle timeout (so a long-running job isn't wrongly rejected)
    return true;
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
