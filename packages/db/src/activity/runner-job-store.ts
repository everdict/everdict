import {
  type ClaimInput,
  POOL_RUNNER,
  type ParkInput,
  type RunnerJobLease,
  type RunnerJobOutcome,
  type RunnerJobStore,
} from "@everdict/application-control";
import { type CaseJob, CaseJobSchema, type CaseResult, CaseResultSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// Store-backed self-hosted runner lease queue (migration 0055) — the multi-replica RunnerHub persistence.
// InMemory mirrors the SQL semantics for tests/single-process; Pg uses FOR UPDATE SKIP LOCKED so two replicas never
// double-claim. See @everdict/application-control RunnerJobStore + docs/architecture/self-hosted-runner.md.

interface Entry {
  jobId: string;
  owner: string;
  runnerId: string;
  tenant?: string;
  job: CaseJob;
  requiredCaps: string[];
  status: "queued" | "leased" | "completed" | "failed";
  cancelRequested: boolean;
  leasedBy?: string;
  activityAt: number;
  result?: CaseResult;
  error?: string;
  createdAt: number;
}
const isTerminal = (e: Entry): boolean => e.status === "completed" || e.status === "failed";
const capsOk = (required: string[], advertised?: string[]): boolean =>
  advertised === undefined || required.every((c) => advertised.includes(c));

export class InMemoryRunnerJobStore implements RunnerJobStore {
  private readonly jobs = new Map<string, Entry>();

  async park(input: ParkInput): Promise<void> {
    this.jobs.set(input.jobId, {
      jobId: input.jobId,
      owner: input.owner,
      runnerId: input.runnerId,
      ...(input.tenant !== undefined ? { tenant: input.tenant } : {}),
      job: input.job,
      requiredCaps: input.requiredCaps,
      status: "queued",
      cancelRequested: false,
      activityAt: input.now,
      createdAt: input.now,
    });
  }

  async claim(input: ClaimInput): Promise<RunnerJobLease | null> {
    // Requeue this owner's expired leases (silent runner) before claiming.
    for (const e of this.jobs.values()) {
      if (e.owner === input.owner && e.status === "leased" && input.now - e.activityAt > input.leaseTtlMs) {
        e.status = "queued";
        e.leasedBy = undefined;
      }
    }
    const candidates = [...this.jobs.values()]
      .filter(
        (e) =>
          e.owner === input.owner &&
          e.status === "queued" &&
          (e.runnerId === input.runnerId || e.runnerId === POOL_RUNNER) &&
          capsOk(e.requiredCaps, input.advertisedCaps),
      )
      .sort(
        (a, b) =>
          (a.runnerId === POOL_RUNNER ? 1 : 0) - (b.runnerId === POOL_RUNNER ? 1 : 0) || a.createdAt - b.createdAt,
      );
    const e = candidates[0];
    if (!e) return null;
    e.status = "leased";
    e.leasedBy = input.runnerId;
    e.activityAt = input.now;
    return { jobId: e.jobId, job: e.job };
  }

  async touch(jobId: string, now: number): Promise<{ extended: boolean; cancelled: boolean }> {
    const e = this.jobs.get(jobId);
    if (!e || isTerminal(e)) return { extended: false, cancelled: false };
    e.activityAt = now;
    return { extended: true, cancelled: e.cancelRequested };
  }

  async complete(jobId: string, result: CaseResult, ranBy: string): Promise<boolean> {
    const e = this.jobs.get(jobId);
    if (!e || isTerminal(e)) return false;
    e.status = "completed";
    e.result = result;
    e.leasedBy = ranBy;
    return true;
  }

  async fail(jobId: string, message: string): Promise<boolean> {
    const e = this.jobs.get(jobId);
    if (!e || isTerminal(e)) return false;
    e.status = "failed";
    e.error = message;
    return true;
  }

  async expire(jobId: string): Promise<void> {
    const e = this.jobs.get(jobId);
    if (e && !isTerminal(e)) {
      e.status = "failed";
      e.error = "no_runner: idle timeout (no lease/heartbeat activity)";
    }
  }

  async outcome(jobId: string): Promise<RunnerJobOutcome | null> {
    const e = this.jobs.get(jobId);
    if (!e) return null;
    return {
      status: e.cancelRequested && !isTerminal(e) ? "cancelled" : e.status,
      ...(e.result !== undefined ? { result: e.result } : {}),
      ...(e.error !== undefined ? { error: e.error } : {}),
      ...(e.leasedBy !== undefined ? { ranBy: e.leasedBy } : {}),
      activityAt: e.activityAt,
    };
  }

  async cancel(match: (job: CaseJob) => boolean): Promise<number> {
    let n = 0;
    for (const e of this.jobs.values()) {
      if (!isTerminal(e) && !e.cancelRequested && match(e.job)) {
        e.cancelRequested = true;
        n++;
      }
    }
    return n;
  }

  async pending(owner: string, runnerId: string): Promise<number> {
    return [...this.jobs.values()].filter((e) => e.owner === owner && e.runnerId === runnerId && !isTerminal(e)).length;
  }
}

interface JobRow {
  job_id: string;
  job: unknown;
  cancel_requested: boolean;
  status: string;
  result: unknown;
  error: string | null;
  leased_by: string | null;
  activity_ms: string; // extract(epoch ...) comes back as a numeric string
}

export class PgRunnerJobStore implements RunnerJobStore {
  constructor(private readonly client: SqlClient) {}

  async park(input: ParkInput): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_runner_jobs (job_id, owner, runner_id, tenant, job, required_caps, activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))`,
      [
        input.jobId,
        input.owner,
        input.runnerId,
        input.tenant ?? null,
        JSON.stringify(input.job),
        input.requiredCaps,
        input.now,
      ],
    );
  }

  async claim(input: ClaimInput): Promise<RunnerJobLease | null> {
    // Requeue this owner's expired leases (silent runner) before claiming.
    await this.client.query(
      `UPDATE everdict_runner_jobs SET status = 'queued', leased_by = NULL
       WHERE owner = $1 AND status = 'leased' AND activity_at < to_timestamp($2 / 1000.0) - make_interval(secs => $3)`,
      [input.owner, input.now, input.leaseTtlMs / 1000],
    );
    // Own queue before the owner pool (ORDER BY runner_id <> '*' DESC), FIFO; capability gate via array containment.
    const res = await this.client.query<{ job_id: string; job: unknown }>(
      `UPDATE everdict_runner_jobs SET status = 'leased', leased_by = $2, activity_at = to_timestamp($5 / 1000.0)
       WHERE job_id = (
         SELECT job_id FROM everdict_runner_jobs
         WHERE owner = $1 AND (runner_id = $2 OR runner_id = $3) AND status = 'queued'
           AND ($4::text[] IS NULL OR required_caps <@ $4::text[])
         ORDER BY (runner_id <> $3) DESC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING job_id, job`,
      [input.owner, input.runnerId, POOL_RUNNER, input.advertisedCaps ?? null, input.now],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { jobId: row.job_id, job: CaseJobSchema.parse(row.job) };
  }

  async touch(jobId: string, now: number): Promise<{ extended: boolean; cancelled: boolean }> {
    const res = await this.client.query<{ cancel_requested: boolean }>(
      `UPDATE everdict_runner_jobs SET activity_at = to_timestamp($2 / 1000.0)
       WHERE job_id = $1 AND status IN ('queued', 'leased')
       RETURNING cancel_requested`,
      [jobId, now],
    );
    const row = res.rows[0];
    if (!row) return { extended: false, cancelled: false };
    return { extended: true, cancelled: row.cancel_requested === true };
  }

  async complete(jobId: string, result: CaseResult, ranBy: string): Promise<boolean> {
    const res = await this.client.query<{ job_id: string }>(
      `UPDATE everdict_runner_jobs SET status = 'completed', result = $2, leased_by = $3
       WHERE job_id = $1 AND status IN ('queued', 'leased') RETURNING job_id`,
      [jobId, JSON.stringify(result), ranBy],
    );
    return res.rows.length > 0;
  }

  async fail(jobId: string, message: string): Promise<boolean> {
    const res = await this.client.query<{ job_id: string }>(
      `UPDATE everdict_runner_jobs SET status = 'failed', error = $2
       WHERE job_id = $1 AND status IN ('queued', 'leased') RETURNING job_id`,
      [jobId, message],
    );
    return res.rows.length > 0;
  }

  async expire(jobId: string): Promise<void> {
    await this.client.query(
      `UPDATE everdict_runner_jobs SET status = 'failed', error = $2
       WHERE job_id = $1 AND status IN ('queued', 'leased')`,
      [jobId, "no_runner: idle timeout (no lease/heartbeat activity)"],
    );
  }

  async outcome(jobId: string): Promise<RunnerJobOutcome | null> {
    const res = await this.client.query<JobRow>(
      `SELECT status, cancel_requested, result, error, leased_by, extract(epoch from activity_at) * 1000 AS activity_ms
       FROM everdict_runner_jobs WHERE job_id = $1`,
      [jobId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const terminal = row.status === "completed" || row.status === "failed";
    return {
      status: row.cancel_requested && !terminal ? "cancelled" : (row.status as RunnerJobOutcome["status"]),
      ...(row.result != null ? { result: CaseResultSchema.parse(row.result) } : {}),
      ...(row.error != null ? { error: row.error } : {}),
      ...(row.leased_by != null ? { ranBy: row.leased_by } : {}),
      activityAt: Number(row.activity_ms),
    };
  }

  async cancel(match: (job: CaseJob) => boolean): Promise<number> {
    const res = await this.client.query<{ job_id: string; job: unknown }>(
      `SELECT job_id, job FROM everdict_runner_jobs WHERE status IN ('queued', 'leased') AND NOT cancel_requested`,
    );
    const ids = res.rows.filter((r) => match(CaseJobSchema.parse(r.job))).map((r) => r.job_id);
    if (ids.length === 0) return 0;
    await this.client.query("UPDATE everdict_runner_jobs SET cancel_requested = true WHERE job_id = ANY($1)", [ids]);
    return ids.length;
  }

  async pending(owner: string, runnerId: string): Promise<number> {
    const res = await this.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM everdict_runner_jobs WHERE owner = $1 AND runner_id = $2 AND status IN ('queued', 'leased')",
      [owner, runnerId],
    );
    return Number(res.rows[0]?.count ?? 0);
  }
}
