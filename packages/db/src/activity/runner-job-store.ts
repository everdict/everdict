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
  leaseEpoch?: number; // minted per claim — the physical attempt's identity (see the port)
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
    // Requeue this owner's expired leases (silent runner) before claiming. A cancelled job is NEVER requeued
    // or claimed (in-memory-hub parity: requeueExpired/orderLeasable have always skipped it) — re-dispatching
    // work the control plane has already stopped is how a cancel became a hint the queue was free to ignore.
    for (const e of this.jobs.values()) {
      if (
        e.owner === input.owner &&
        e.status === "leased" &&
        !e.cancelRequested &&
        input.now - e.activityAt > input.leaseTtlMs
      ) {
        e.status = "queued";
        e.leasedBy = undefined;
      }
    }
    const candidates = [...this.jobs.values()]
      .filter(
        (e) =>
          e.owner === input.owner &&
          e.status === "queued" &&
          !e.cancelRequested &&
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
    e.leaseEpoch = (e.leaseEpoch ?? 0) + 1; // a new physical attempt on the same job
    e.activityAt = input.now;
    return { jobId: e.jobId, job: e.job, leaseEpoch: e.leaseEpoch };
  }

  async restampJob(jobId: string, runnerId: string, leaseEpoch: number, job: CaseJob): Promise<boolean> {
    const e = this.jobs.get(jobId);
    if (!this.holdsWritableLease(e, runnerId, leaseEpoch)) return false;
    e.job = job;
    return true;
  }

  async authorize(jobId: string, runnerId: string, leaseEpoch: number): Promise<CaseJob | null> {
    const e = this.jobs.get(jobId);
    return this.holdsWritableLease(e, runnerId, leaseEpoch) ? e.job : null;
  }

  // The current-lease fence: a report from a lease that was requeued or re-leased acts on nothing. This is the
  // LIVENESS half — it says the caller is who it claims to be, which is what a heartbeat needs in order to be
  // told about a cancel.
  private holdsLease(e: Entry | undefined, runnerId: string, leaseEpoch: number): e is Entry {
    return (
      e !== undefined &&
      e.status === "leased" &&
      e.leasedBy === runnerId &&
      !!e.leaseEpoch &&
      e.leaseEpoch === leaseEpoch
    );
  }

  // ── A CANCEL REVOKES THE CAPABILITY, IT DOES NOT ASK FOR ONE ────────────────────────────────────────
  //
  // The predicate every runner-initiated MUTATION shares (the same one `authorize` reads, so the evidence
  // wire and the result wire revoke together). A cancelled job's holder could previously still complete it —
  // and `outcome` reports a terminal row verbatim, so the cancellation simply vanished from the record and
  // the batch settled as "completed". The runner is told to stop; until it does, its lease authorizes nothing.
  private holdsWritableLease(e: Entry | undefined, runnerId: string, leaseEpoch: number): e is Entry {
    return this.holdsLease(e, runnerId, leaseEpoch) && !e.cancelRequested;
  }

  // Deliberately fenced on the lease only, NOT on the cancel flag: a cancelled lease must still HEAR its
  // cancel on the heartbeat reply (that is how the runner learns to abort and free the runtime). What it
  // stops getting is the extension — activity_at freezes, so a runner that ignores the signal is reclaimed by
  // the idle-timeout path instead of holding the job alive forever with a compliant-looking heartbeat.
  async touch(
    jobId: string,
    runnerId: string,
    leaseEpoch: number,
    now: number,
  ): Promise<{ extended: boolean; cancelled: boolean }> {
    const e = this.jobs.get(jobId);
    if (!this.holdsLease(e, runnerId, leaseEpoch)) return { extended: false, cancelled: false };
    if (e.cancelRequested) return { extended: false, cancelled: true };
    e.activityAt = now;
    return { extended: true, cancelled: false };
  }

  async complete(jobId: string, result: CaseResult, ranBy: string, leaseEpoch: number): Promise<boolean> {
    const e = this.jobs.get(jobId);
    if (!this.holdsWritableLease(e, ranBy, leaseEpoch)) return false;
    e.status = "completed";
    e.result = result;
    return true;
  }

  async fail(jobId: string, message: string, runnerId: string, leaseEpoch: number): Promise<boolean> {
    const e = this.jobs.get(jobId);
    if (!this.holdsWritableLease(e, runnerId, leaseEpoch)) return false;
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
      ...(e.job.recordingGeneration !== undefined ? { recordingGeneration: e.job.recordingGeneration } : {}),
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
  recording_generation: number | null; // job->>'recordingGeneration' — the attempt the row's job currently names
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
    // Requeue this owner's expired leases (silent runner) before claiming. `NOT cancel_requested` on BOTH
    // statements: a cancelled job is neither requeued nor claimed. Without it the queue kept re-dispatching
    // work the control plane had already stopped — the in-memory hub's requeueExpired/orderLeasable have
    // always skipped a cancelled entry, and this is the store lane catching up to that guard.
    await this.client.query(
      `UPDATE everdict_runner_jobs SET status = 'queued', leased_by = NULL
       WHERE owner = $1 AND status = 'leased' AND NOT cancel_requested
         AND activity_at < to_timestamp($2 / 1000.0) - make_interval(secs => $3)`,
      [input.owner, input.now, input.leaseTtlMs / 1000],
    );
    // Own queue before the owner pool (ORDER BY runner_id <> '*' DESC), FIFO; capability gate via array containment.
    const res = await this.client.query<{ job_id: string; job: unknown; lease_epoch: number }>(
      `UPDATE everdict_runner_jobs SET status = 'leased', leased_by = $2, lease_epoch = lease_epoch + 1,
              activity_at = to_timestamp($5 / 1000.0)
       WHERE job_id = (
         SELECT job_id FROM everdict_runner_jobs
         WHERE owner = $1 AND (runner_id = $2 OR runner_id = $3) AND status = 'queued' AND NOT cancel_requested
           AND ($4::text[] IS NULL OR required_caps <@ $4::text[])
         ORDER BY (runner_id <> $3) DESC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING job_id, job, lease_epoch`,
      [input.owner, input.runnerId, POOL_RUNNER, input.advertisedCaps ?? null, input.now],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { jobId: row.job_id, job: CaseJobSchema.parse(row.job), leaseEpoch: Number(row.lease_epoch) };
  }

  // The lease-time attempt restamp — same current-lease predicate as every other runner-initiated mutation
  // below, so a claim that has already moved the row on cannot have its job overwritten by a late restamp.
  async restampJob(jobId: string, runnerId: string, leaseEpoch: number, job: CaseJob): Promise<boolean> {
    const res = await this.client.query<{ job_id: string }>(
      `UPDATE everdict_runner_jobs SET job = $4
       WHERE job_id = $1 AND status = 'leased' AND leased_by = $2 AND lease_epoch = $3 AND lease_epoch > 0
         AND NOT cancel_requested
       RETURNING job_id`,
      [jobId, runnerId, leaseEpoch, JSON.stringify(job)],
    );
    return res.rows.length > 0;
  }

  // The authorization read, in ONE statement so it cannot see a lease that a concurrent claim has already
  // moved on from. `status = 'leased'` matters as much as the epoch: a completed job's holder has no further
  // right to publish evidence under it — and neither has a CANCELLED one, which is why the same
  // `NOT cancel_requested` that guards the mutations guards this read (arch-review 46: cancellation is
  // capability revocation, so the evidence endpoints stop accepting the moment the cancel lands).
  async authorize(jobId: string, runnerId: string, leaseEpoch: number): Promise<CaseJob | null> {
    const res = await this.client.query<{ job: unknown }>(
      `SELECT job FROM everdict_runner_jobs
       WHERE job_id = $1 AND leased_by = $2 AND lease_epoch = $3 AND status = 'leased' AND lease_epoch > 0
         AND NOT cancel_requested`,
      [jobId, runnerId, leaseEpoch],
    );
    const row = res.rows[0];
    return row ? CaseJobSchema.parse(row.job) : null;
  }

  // Every runner-initiated mutation below shares one WHERE clause with `authorize`: the row must still be
  // THIS runner's CURRENT lease. `status = 'leased'` (never 'queued') — a requeued job's previous holder has
  // no further right to end it, extend it, or overwrite who held it; and the epoch pins which lease of this
  // runner's it was (a re-lease of the same job to the same runner mints a new epoch).
  async touch(
    jobId: string,
    runnerId: string,
    leaseEpoch: number,
    now: number,
  ): Promise<{ extended: boolean; cancelled: boolean }> {
    // The one mutation NOT gated on `NOT cancel_requested` — a cancelled lease must still HEAR its cancel here
    // (that reply is how the runner learns to abort the local run and free the runtime). What it loses is the
    // EXTENSION: the CASE freezes activity_at, so a runner that keeps heartbeating without complying stops
    // looking alive and the idle-timeout path reclaims the job instead of it being renewed forever.
    const res = await this.client.query<{ cancel_requested: boolean }>(
      `UPDATE everdict_runner_jobs
          SET activity_at = CASE WHEN cancel_requested THEN activity_at ELSE to_timestamp($4 / 1000.0) END
       WHERE job_id = $1 AND status = 'leased' AND leased_by = $2 AND lease_epoch = $3 AND lease_epoch > 0
       RETURNING cancel_requested`,
      [jobId, runnerId, leaseEpoch, now],
    );
    const row = res.rows[0];
    if (!row) return { extended: false, cancelled: false };
    const cancelled = row.cancel_requested === true;
    return { extended: !cancelled, cancelled };
  }

  // A CANCELLED lease may not end the job either (arch-review 46). `outcome` reports a terminal row verbatim —
  // it only synthesizes "cancelled" while the row is still queued/leased — so a cancelled job's holder landing
  // its complete() erased the cancellation from the record: the batch read back "completed" and the user's stop
  // had, on the evidence, never happened.
  async complete(jobId: string, result: CaseResult, ranBy: string, leaseEpoch: number): Promise<boolean> {
    const res = await this.client.query<{ job_id: string }>(
      `UPDATE everdict_runner_jobs SET status = 'completed', result = $2
       WHERE job_id = $1 AND status = 'leased' AND leased_by = $3 AND lease_epoch = $4 AND lease_epoch > 0
         AND NOT cancel_requested
       RETURNING job_id`,
      [jobId, JSON.stringify(result), ranBy, leaseEpoch],
    );
    return res.rows.length > 0;
  }

  async fail(jobId: string, message: string, runnerId: string, leaseEpoch: number): Promise<boolean> {
    const res = await this.client.query<{ job_id: string }>(
      `UPDATE everdict_runner_jobs SET status = 'failed', error = $2
       WHERE job_id = $1 AND status = 'leased' AND leased_by = $3 AND lease_epoch = $4 AND lease_epoch > 0
         AND NOT cancel_requested
       RETURNING job_id`,
      [jobId, message, runnerId, leaseEpoch],
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
    // The generation is projected OUT of the job document rather than parsing the whole CaseJob back: this is
    // the parking replica's poll loop (once per pollMs, per in-flight job), and only that one number is read.
    const res = await this.client.query<JobRow>(
      `SELECT status, cancel_requested, result, error, leased_by, (job->>'recordingGeneration')::int AS recording_generation,
              extract(epoch from activity_at) * 1000 AS activity_ms
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
      ...(row.recording_generation != null ? { recordingGeneration: Number(row.recording_generation) } : {}),
      activityAt: Number(row.activity_ms),
    };
  }

  async cancel(match: (job: CaseJob) => boolean): Promise<number> {
    const res = await this.client.query<{ job_id: string; job: unknown; lease_epoch: number }>(
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
