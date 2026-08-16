import { randomUUID } from "node:crypto";
import { type CaseJob, type CaseResult, UpstreamError } from "@everdict/contracts";
import type { ExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import type {
  ClaimAttemptMint,
  ClaimInput,
  ClaimedAttempt,
  RunnerJobLease,
  RunnerJobStore,
} from "../ports/runner-job-store.js";
import {
  type AttemptAuthority,
  type AttemptToken,
  type EnqueueResult,
  type LeasedJob,
  type OpenAttempt,
  type OpenedAttempt,
  type RunnerHub,
  type SelfHostedKey,
  normalizeOpenedAttempt,
  requiredRunnerCapabilities,
  restampedJob,
} from "./runner-hub.js";

// What the CLAIM lane's attempt open is told (arch-review 47 §5.1). The dispatch lanes keep `OpenAttempt`,
// which closes over the composition's ambient stores and answers with a coordinate; this one additionally
// carries the two things only a claim knows: the LEDGER the writes must go through — the claim transaction's
// own twin, so the attempt row and the lease commit together — and the PREDECESSOR the row names, which is
// the attempt this re-lease replaces and which no replica but this row could have named.
export interface LeaseAttemptOpen {
  job: CaseJob;
  leaseEpoch: number;
  // Absent = the store had no transaction to bind (the in-memory twin); the opener uses its ambient ledger.
  attempts?: ExecutionAttemptStore;
  prior?: string;
}
export type OpenLeaseAttempt = (input: LeaseAttemptOpen) => Promise<OpenedAttempt>;

export interface StoreRunnerHubDeps {
  queueTimeoutMs?: number; // idle timeout — no lease/heartbeat activity for this long → no_runner (default 5 min)
  leaseTtlMs?: number; // a lease with no heartbeat for this long is requeued (runner died) (default 2 min)
  pollMs?: number; // store poll interval for claim (lease long-poll) and outcome (dispatch wait) (default 1s)
  newJobId?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  openAttempt?: OpenAttempt; // see RunnerHubDeps.openAttempt + OpenedAttempt — the store twin
  // The transactional lane's opener. Wired ⇒ a claim mints its attempt INSIDE the claim transaction
  // (RunnerJobStore.claimAttempt); unwired ⇒ the three-step path below, unchanged.
  openLeaseAttempt?: OpenLeaseAttempt;
}

// Store-backed RunnerHub — the multi-replica counterpart to the in-memory RunnerHub. Same public surface (enqueue /
// leaseWait / heartbeat / complete / fail / requestCancel / pending), but every op goes through a shared RunnerJobStore
// so a job parked on one control-plane replica is leased + completed from another. The methods are async; callers await
// them (which also works unchanged against the sync in-memory hub — await on a plain value is a no-op). The parking
// replica enforces the idle timeout itself by polling the row's activity_at (kept fresh cross-replica by lease/heartbeat),
// mirroring the per-job timer the in-memory hub kept locally. Design: docs/architecture/self-hosted-runner.md.
export class StoreRunnerHub {
  private readonly queueTimeoutMs: number;
  private readonly leaseTtlMs: number;
  private readonly pollMs: number;
  private readonly newJobId: () => string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly openAttempt: OpenAttempt | undefined;
  private readonly openLeaseAttempt: OpenLeaseAttempt | undefined;
  constructor(
    private readonly store: RunnerJobStore,
    deps: StoreRunnerHubDeps = {},
  ) {
    this.queueTimeoutMs = deps.queueTimeoutMs ?? 300_000;
    this.leaseTtlMs = deps.leaseTtlMs ?? 120_000;
    this.pollMs = deps.pollMs ?? 1_000;
    this.newJobId = deps.newJobId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.openAttempt = deps.openAttempt;
    this.openLeaseAttempt = deps.openLeaseAttempt;
  }

  // Park a job and poll the store until it settles — resolves on complete, rejects on fail/cancel, and rejects as
  // no_runner if activity_at goes stale (no runner leased/heartbeated it in queueTimeoutMs — connected-but-busy runners
  // keep it fresh via their heartbeat, exactly like the in-memory hub).
  async enqueue(key: SelfHostedKey, job: CaseJob, onLease?: () => void): Promise<EnqueueResult> {
    const jobId = this.newJobId();
    await this.store.park({
      jobId,
      owner: key.owner,
      runnerId: key.runnerId,
      ...(job.tenant !== undefined ? { tenant: job.tenant } : {}),
      job,
      requiredCaps: requiredRunnerCapabilities(job),
      now: this.now(),
      // …and the attempt the DISPATCH opened lands on the row with it (arch-review 51). It is the only way
      // that attempt's id reaches the replica serving a later re-lease — which reads it as `prior` and ends
      // it. Absent when the dispatch opened none (no ledger wired), exactly as this park behaved before.
      ...(job.attemptId !== undefined ? { attemptId: job.attemptId } : {}),
    });
    // The parking replica polls the shared store; when the (cross-replica) claim first marks the row "leased" it
    // fires onLease once → the caller flips the run record queued→running. The run store is shared, so this works
    // even though a different replica did the claim. Best-effort, exactly like the in-memory hub's fireOnLease.
    let onLeaseFired = false;
    for (;;) {
      await this.sleep(this.pollMs);
      const o = await this.store.outcome(jobId);
      if (o && !onLeaseFired && onLease && o.status === "leased") {
        onLeaseFired = true;
        try {
          onLease();
        } catch (e) {
          console.warn(`[runner-hub] onLease hook threw for job ${jobId}: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (!o) {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { runnerId: key.runnerId, jobId },
          "Self-hosted job disappeared from the queue before completing.",
        );
      }
      if (o.status === "completed" && o.result) {
        // The attempt's coordinate comes off the ROW, not off the job this replica parked: a re-lease
        // restamped it, and this replica never saw that claim (it may not even have served it). Both halves —
        // an unisolated re-lease carries the NAME and no generation, and reading only the generation left
        // this reply empty on exactly that lane (arch-review 52).
        return {
          result: o.result,
          ranBy: o.ranBy ?? key.runnerId,
          ...(o.recordingGeneration !== undefined ? { generation: o.recordingGeneration } : {}),
          ...(o.attemptId !== undefined ? { attemptId: o.attemptId } : {}),
        };
      }
      if (o.status === "failed") {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { runnerId: key.runnerId, jobId },
          o.error ?? "The self-hosted runner reported a failure.",
        );
      }
      if (o.status === "cancelled") {
        throw new UpstreamError("UPSTREAM_ERROR", { jobId, reason: "cancelled" }, o.error ?? "Run cancelled.");
      }
      // Still queued/leased — enforce the idle timeout off the (cross-replica) activity clock.
      if (this.now() - o.activityAt > this.queueTimeoutMs) {
        await this.store.expire(jobId);
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { runnerId: key.runnerId, reason: "no_runner" },
          "No self-hosted runner activity — the runner is not connected, is idle/dead, or attached to a replica that " +
            "cannot reach this job's store. Check the runner is online.",
        );
      }
    }
  }

  // Long-poll lease — poll the store for a claimable job until waitMs elapses (null if none). Cross-replica atomic claim.
  async leaseWait(key: SelfHostedKey, waitMs: number, capabilities?: string[]): Promise<LeasedJob | null> {
    const deadline = this.now() + waitMs;
    for (;;) {
      const leased = await this.claimOnce(key, capabilities);
      // A lost mint hands out NOTHING; the loop re-claims. Handing the runner a job whose row the store will
      // never authorize is duplicate compute plus an orphan. (The transactional lane cannot lose a mint — see
      // claimWithAttempt — so this is the three-step path's outcome.)
      if (leased)
        return {
          jobId: leased.jobId,
          job: leased.job,
          attempt: { jobId: leased.jobId, leaseEpoch: leased.leaseEpoch },
        };
      const remaining = deadline - this.now();
      if (remaining <= 0) return null;
      await this.sleep(Math.min(this.pollMs, remaining));
    }
  }

  // One claim attempt: the §5.1 transaction when both halves of it are present, else the three-step path this
  // hub has always run. The choice is per-deployment, not per-call — a store with no `claimAttempt` (or a
  // composition that wired no lease opener) keeps the old sequence byte for byte.
  private async claimOnce(key: SelfHostedKey, capabilities?: string[]): Promise<RunnerJobLease | null> {
    const input: ClaimInput = {
      owner: key.owner,
      runnerId: key.runnerId,
      ...(capabilities !== undefined ? { advertisedCaps: capabilities } : {}),
      leaseTtlMs: this.leaseTtlMs,
      now: this.now(),
    };
    const open = this.openLeaseAttempt;
    if (this.store.claimAttempt && open) return this.store.claimAttempt(input, this.claimWithAttempt(open));
    const claimed = await this.store.claim(input);
    if (!claimed) return null;
    const job = await this.mintAttempt(claimed, key);
    return job === null ? null : { ...claimed, job };
  }

  // ── THE CLAIM'S LEDGER WORK, INSIDE THE CLAIM (arch-review 47 §5.1) ─────────────────────────────────
  //
  // The same decisions `mintAttempt` makes below, minus every one that existed only because they were three
  // separate round-trips. There is no restamp to lose (the transaction holds the row, so nothing can move it),
  // hence no just-opened attempt to supersede again; and the PREDECESSOR — unreachable on this lane until the
  // row started carrying it — is ended here, by the claim that replaced it, on whichever replica serves it.
  //
  // The stamps are AWAITED and NOT swallowed, which is the whole difference from the best-effort posture the
  // three-step path documents: they ride a transaction now, so a stamp that fails takes the lease with it
  // rather than leaving a lease whose attempt the ledger never recorded.
  private claimWithAttempt(open: OpenLeaseAttempt): ClaimAttemptMint {
    return async (claimed, ledger): Promise<ClaimedAttempt> => {
      // Epoch 1 is the FIRST lease: it runs the attempt the dispatch already opened, so there is nothing to
      // mint, nothing to supersede (no handle to the dispatch's attempt reaches this lane) and no restamp owed.
      if (claimed.leaseEpoch <= 1) return {};
      const opened = await open({
        job: claimed.job,
        leaseEpoch: claimed.leaseEpoch,
        ...(ledger.attempts !== undefined ? { attempts: ledger.attempts } : {}),
        ...(ledger.prior !== undefined ? { prior: ledger.prior } : {}),
      });
      // The lease IS the dispatch, so compute starts under this attempt the moment the claim commits.
      await opened.markExecuting?.();
      // A mint that produced no coordinate strips the inherited one (fail-closed → the live-only lane); the
      // attempt ROW still exists and still says what ran, which is the point of the ledger.
      const job = restampedJob(claimed.job, opened);
      return { job, ...(opened.attemptId !== undefined ? { attemptId: opened.attemptId } : {}) };
    };
  }

  // The store twin of RunnerHub.mintAttempt — a claim that RE-leases a requeued job (epoch > 1) is a new
  // physical execution, so it opens its own recording generation instead of inheriting the first attempt's.
  // The restamp is PERSISTED because `authorize` answers every later evidence push out of the row: a number
  // that lived only in this reply would leave the durable lane still handing out the previous attempt's.
  // A failed open strips the inherited number (fail-closed → the live-only lane); a failed restamp is NOT
  // swallowed, so the runner never receives a lease whose row still points at the other execution.
  //
  // The attempt this re-lease REPLACES is named by the job it claimed (`CaseJob.attemptId`, arch-review 51)
  // and superseded by the opener — so the predecessor no longer stands `executing` for ever on this path
  // either. What this path still cannot do is make that ONE decision: the supersede, the open and the restamp
  // are separate round-trips, so a crash between them leaves a predecessor ended by a lease that never
  // committed. That is what `claimWithAttempt` above is for, and a deployment whose store offers
  // `claimAttempt` never reaches this method. This one remains for the stores that cannot transact, where the
  // residue is reconciled like every other pre-promotion row (an attempt row whose execution has a terminal
  // outcome is not that outcome's authority).
  private async mintAttempt(claimed: RunnerJobLease, key: SelfHostedKey): Promise<CaseJob | null> {
    if (claimed.leaseEpoch <= 1 || !this.openAttempt) return claimed.job;
    const opened = normalizeOpenedAttempt(
      await this.openAttempt(claimed.job, {
        leaseEpoch: claimed.leaseEpoch,
        // The attempt this re-lease replaces, as the JOB names it (arch-review 51): the dispatch's own on the
        // first re-lease, and thereafter whichever attempt the previous mint restamped the job with.
        ...(claimed.job.attemptId !== undefined ? { prior: claimed.job.attemptId } : {}),
      }).catch(() => undefined),
    );
    const job = restampedJob(claimed.job, opened);
    // The restamp's answer IS the claim's answer (arch-review 47 P1-1): false means the row moved while the
    // open was in flight — a cancel, an expiry sweep, another claim — and the store will refuse every
    // authorize/complete under this lease. The boolean was ignored, so the runner received a job it could
    // execute but never report: duplicate compute, an orphan attempt, and a result the ledger never saw.
    const restamped = await this.store.restampJob(claimed.jobId, key.runnerId, claimed.leaseEpoch, job);
    if (!restamped) {
      // The attempt this lost claim opened is ended rather than left at `created` (arch-review 47 P1-3) —
      // no execution will ever happen under it, and nobody else holds a handle to say so.
      await opened.supersede?.("lease lost during mint").catch(() => {});
      return null;
    }
    // The lease is the dispatch, so compute starts under this attempt now; the stamp carries the epoch that
    // authorized it. Best-effort — no transaction to ride (see ports/execution-attempt-store.ts).
    await opened.markExecuting?.().catch(() => {});
    return job;
  }

  // The durable, CROSS-REPLICA authorization read (see RunnerJobStore.authorize). The in-memory hub can only
  // answer for leases its own process holds; this one answers for the deployment, which is why a control plane
  // that runs several replicas should be on the store-backed hub before it trusts pushed evidence.
  async authorizeAttempt(key: SelfHostedKey, token: AttemptToken): Promise<AttemptAuthority | undefined> {
    const job = await this.store.authorize(token.jobId, key.runnerId, token.leaseEpoch).catch(() => null);
    if (!job) return undefined;
    return {
      ...(job.runId ? { runId: job.runId } : {}),
      ...(job.tenant ? { tenant: job.tenant } : {}),
      ...(job.recordingGeneration !== undefined ? { recordingGeneration: job.recordingGeneration } : {}),
      runnerId: key.runnerId,
    };
  }

  // Liveness + the control plane's cancel decision (carried back to the runner's next heartbeat), same as the
  // in-memory hub. The token rides down to the store's WHERE clause — a stale holder's heartbeat must not renew
  // the successor's lease, so the fence is the row's, not this process's. `capabilities` is accepted for
  // signature parity with the in-memory hub and unused: the store path has no per-process timers to rearm
  // (each parking replica enforces the idle timeout off the shared activity clock).
  heartbeat(
    key: SelfHostedKey,
    token: AttemptToken,
    _capabilities?: string[],
  ): Promise<{ extended: boolean; cancelled: boolean }> {
    return this.store.touch(token.jobId, key.runnerId, token.leaseEpoch, this.now());
  }

  complete(key: SelfHostedKey, token: AttemptToken, result: CaseResult): Promise<boolean> {
    return this.store.complete(token.jobId, result, key.runnerId, token.leaseEpoch);
  }

  fail(key: SelfHostedKey, token: AttemptToken, message: string): Promise<boolean> {
    return this.store.fail(token.jobId, message, key.runnerId, token.leaseEpoch);
  }

  requestCancel(predicate: (job: CaseJob) => boolean): Promise<number> {
    return this.store.cancel(predicate);
  }

  pending(key: SelfHostedKey): Promise<number> {
    return this.store.pending(key.owner, key.runnerId);
  }
}

// The lease-hub abstraction the control plane holds — the in-memory RunnerHub (single-process) or the store-backed
// StoreRunnerHub (multi-replica), chosen at composition. Callers await its methods, which works against both (await on
// the in-memory hub's synchronous return is a no-op), so this union is the only surface the dispatch/MCP layer needs.
export type RunnerHubLike = RunnerHub | StoreRunnerHub;
