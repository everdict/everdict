import { randomUUID } from "node:crypto";
import { type AgentJob, type CaseResult, UpstreamError } from "@everdict/contracts";
import type { RunnerJobStore } from "../ports/runner-job-store.js";
import { type EnqueueResult, type LeasedJob, type SelfHostedKey, requiredRunnerCapabilities } from "./runner-hub.js";

export interface StoreRunnerHubDeps {
  queueTimeoutMs?: number; // idle timeout — no lease/heartbeat activity for this long → no_runner (default 5 min)
  leaseTtlMs?: number; // a lease with no heartbeat for this long is requeued (runner died) (default 2 min)
  pollMs?: number; // store poll interval for claim (lease long-poll) and outcome (dispatch wait) (default 1s)
  newJobId?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
  }

  // Park a job and poll the store until it settles — resolves on complete, rejects on fail/cancel, and rejects as
  // no_runner if activity_at goes stale (no runner leased/heartbeated it in queueTimeoutMs — connected-but-busy runners
  // keep it fresh via their heartbeat, exactly like the in-memory hub).
  async enqueue(key: SelfHostedKey, job: AgentJob): Promise<EnqueueResult> {
    const jobId = this.newJobId();
    await this.store.park({
      jobId,
      owner: key.owner,
      runnerId: key.runnerId,
      ...(job.tenant !== undefined ? { tenant: job.tenant } : {}),
      job,
      requiredCaps: requiredRunnerCapabilities(job),
      now: this.now(),
    });
    for (;;) {
      await this.sleep(this.pollMs);
      const o = await this.store.outcome(jobId);
      if (!o) {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { runnerId: key.runnerId, jobId },
          "Self-hosted job disappeared from the queue before completing.",
        );
      }
      if (o.status === "completed" && o.result) {
        return { result: o.result, ranBy: o.ranBy ?? key.runnerId };
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
      const claimed = await this.store.claim({
        owner: key.owner,
        runnerId: key.runnerId,
        ...(capabilities !== undefined ? { advertisedCaps: capabilities } : {}),
        leaseTtlMs: this.leaseTtlMs,
        now: this.now(),
      });
      if (claimed) return claimed;
      const remaining = deadline - this.now();
      if (remaining <= 0) return null;
      await this.sleep(Math.min(this.pollMs, remaining));
    }
  }

  // Liveness + the control plane's cancel decision (carried back to the runner's next heartbeat), same as the in-memory hub.
  heartbeat(key: SelfHostedKey, jobId: string): Promise<{ extended: boolean; cancelled: boolean }> {
    return this.store.touch(jobId, this.now());
  }

  complete(key: SelfHostedKey, jobId: string, result: CaseResult): Promise<boolean> {
    return this.store.complete(jobId, result, key.runnerId);
  }

  fail(key: SelfHostedKey, jobId: string, message: string): Promise<boolean> {
    return this.store.fail(jobId, message);
  }

  requestCancel(predicate: (job: AgentJob) => boolean): Promise<number> {
    return this.store.cancel(predicate);
  }

  pending(key: SelfHostedKey): Promise<number> {
    return this.store.pending(key.owner, key.runnerId);
  }
}
