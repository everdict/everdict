import {
  type ClaimAttemptMint,
  type ClaimInput,
  POOL_RUNNER,
  type ParkInput,
  type RunnerJobLease,
  type RunnerJobOutcome,
  type RunnerJobStore,
} from "@everdict/application-control";
import { type CaseJob, CaseJobSchema, type CaseResult, CaseResultSchema } from "@everdict/contracts";
import { type SqlClient, withTransaction } from "../client.js";
import { PgExecutionAttemptStore } from "../results/pg-execution-attempt-store.js";

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
  status: "queued" | "leased" | "completed" | "failed" | "cancelled";
  cancelRequested: boolean;
  leasedBy?: string;
  leaseEpoch?: number; // minted per claim — the physical attempt's identity (see the port)
  // The physical attempt this row currently names (mig 0183's column) — the predecessor the NEXT claim
  // supersedes. Undefined for a job whose only attempt is its dispatch's own.
  currentAttemptId?: string;
  activityAt: number;
  result?: CaseResult;
  error?: string;
  createdAt: number;
}
const isTerminal = (e: Entry): boolean => e.status === "completed" || e.status === "failed" || e.status === "cancelled";
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
      // The attempt the DISPATCH opened (arch-review 51) — the predecessor the first re-lease supersedes.
      ...(input.attemptId !== undefined ? { currentAttemptId: input.attemptId } : {}),
      activityAt: input.now,
      createdAt: input.now,
    });
  }

  async claim(input: ClaimInput): Promise<RunnerJobLease | null> {
    // Requeue this owner's expired leases (silent runner) before claiming. A cancelled job is NEVER requeued
    // or claimed (in-memory-hub parity: requeueExpired/orderLeasable have always skipped it) — re-dispatching
    // work the control plane has already stopped is how a cancel became a hint the queue was free to ignore.
    for (const e of this.jobs.values()) {
      if (e.owner !== input.owner || e.status !== "leased" || input.now - e.activityAt <= input.leaseTtlMs) continue;
      if (e.cancelRequested) {
        // A cancelled lease whose runner went silent terminalizes here (arch-review 47 P1-2) — the sweep is
        // the non-compliant holder's reclaim, and limbo ("excluded from requeue, ended by nothing") is not
        // a state.
        e.status = "cancelled";
        continue;
      }
      e.status = "queued";
      e.leasedBy = undefined;
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

  // The single-process twin of the claim transaction (see RunnerJobStore.claimAttempt). Same SEQUENCE — claim,
  // then the mint's ledger work against the row's predecessor, then the restamp — and the same visible
  // outcome, run sequentially because this store has no transaction to bind a ledger twin to (`attempts` is
  // therefore omitted, and the caller writes through its own ambient ledger).
  //
  // What it approximates rather than provides is ROLLBACK: a mint that throws has already had its claim
  // applied, so the entry is put back to `queued` by hand. The epoch is deliberately NOT rolled back with it —
  // epochs only ever move forward here, so a retry of this claim mints a fresh one and the abandoned number
  // can never be handed out twice.
  async claimAttempt(input: ClaimInput, mint: ClaimAttemptMint): Promise<RunnerJobLease | null> {
    const lease = await this.claim(input);
    if (!lease) return null;
    const e = this.jobs.get(lease.jobId);
    try {
      const minted = await mint(lease, { ...(e?.currentAttemptId !== undefined ? { prior: e.currentAttemptId } : {}) });
      if (e) {
        if (minted.job !== undefined) e.job = minted.job;
        if (minted.attemptId !== undefined) e.currentAttemptId = minted.attemptId;
      }
      return { ...lease, ...(minted.job !== undefined ? { job: minted.job } : {}) };
    } catch (err) {
      if (e && e.status === "leased" && e.leaseEpoch === lease.leaseEpoch) {
        e.status = "queued";
        e.leasedBy = undefined;
      }
      throw err;
    }
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
  // The runner is alive, so every job it could still TAKE stays alive with it — own queue and owner pool,
  // capability-scoped (arch-review 119). The in-memory hub's `rearmWaiting`, expressed on the row the store
  // path enforces the idle timeout off.
  async touchWaiting(input: {
    owner: string;
    runnerId: string;
    advertisedCaps?: string[];
    now: number;
  }): Promise<number> {
    let refreshed = 0;
    for (const e of this.jobs.values()) {
      if (e.owner !== input.owner || e.status !== "queued" || e.cancelRequested) continue;
      if (e.runnerId !== input.runnerId && e.runnerId !== POOL_RUNNER) continue;
      // A job this runner could not claim is not kept alive by it — otherwise a job whose only capable
      // runner died never times out.
      if (input.advertisedCaps && e.requiredCaps.some((c) => !input.advertisedCaps?.includes(c))) continue;
      // Monotonic, and the Pg twin says the same in its WHERE: several replicas write this column and their
      // clocks are not one clock, so a lagging one must not pull a job's liveness BACKWARDS into the timeout.
      // It also keeps a poll that changes nothing from being a write at all.
      if (e.activityAt >= input.now) continue;
      e.activityAt = input.now;
      refreshed += 1;
    }
    return refreshed;
  }

  async touch(
    jobId: string,
    runnerId: string,
    leaseEpoch: number,
    now: number,
  ): Promise<{ extended: boolean; cancelled: boolean }> {
    const e = this.jobs.get(jobId);
    // A row the sweep/ack already terminalized as CANCELLED still ANSWERS its late holder (arch-review 47
    // P1-2): the heartbeat reply is the abort channel, and the holder's identity is still on the row.
    if (e !== undefined && e.status === "cancelled" && e.leasedBy === runnerId && e.leaseEpoch === leaseEpoch)
      return { extended: false, cancelled: true };
    if (!this.holdsLease(e, runnerId, leaseEpoch)) return { extended: false, cancelled: false };
    if (e.cancelRequested) return { extended: false, cancelled: true };
    e.activityAt = now;
    return { extended: true, cancelled: false };
  }

  async complete(jobId: string, result: CaseResult, ranBy: string, leaseEpoch: number): Promise<boolean> {
    const e = this.jobs.get(jobId);
    if (!this.holdsWritableLease(e, ranBy, leaseEpoch)) {
      this.ackCancelled(jobId, ranBy, leaseEpoch);
      return false;
    }
    e.status = "completed";
    e.result = result;
    return true;
  }

  async fail(jobId: string, message: string, runnerId: string, leaseEpoch: number): Promise<boolean> {
    const e = this.jobs.get(jobId);
    if (!this.holdsWritableLease(e, runnerId, leaseEpoch)) {
      this.ackCancelled(jobId, runnerId, leaseEpoch);
      return false;
    }
    e.status = "failed";
    e.error = message;
    return true;
  }

  // The cancelled holder's refused report IS its ack (arch-review 47 P1-2): the lease identity matches, the
  // write was revoked, and the row terminalizes instead of waiting for the TTL sweep.
  private ackCancelled(jobId: string, runnerId: string, leaseEpoch: number): void {
    const e = this.jobs.get(jobId);
    if (e && this.holdsLease(e, runnerId, leaseEpoch) && e.cancelRequested && e.status === "leased")
      e.status = "cancelled";
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
      // WHICH ATTEMPT THE ROW SAYS RAN (arch-review 52). The job's own name first — it is what the lease
      // handed the runner and what its evidence was authorized under — falling back to the row pointer the
      // mint wrote. They are set together; a row that has only the pointer is one whose restamp is the
      // predecessor's, and the pointer is then the more recent of the two.
      ...(e.job.attemptId !== undefined
        ? { attemptId: e.job.attemptId }
        : e.currentAttemptId !== undefined
          ? { attemptId: e.currentAttemptId }
          : {}),
      activityAt: e.activityAt,
    };
  }

  // ── A CANCELLED ROW REACHES A PERSISTED TERMINAL STATE (arch-review 47 P1-2) ──────────────────────
  // The flag alone left a row `queued|leased, cancel_requested` FOREVER: pending counted it, the queue
  // accumulated it, nothing ever ended it. A QUEUED row terminalizes immediately (nobody holds it); a
  // LEASED row keeps the flag — the runner must still HEAR the cancel over its heartbeat — and terminalizes
  // when the runner acks (its refused complete/fail) or the lease TTL sweeps it.
  async cancel(match: (job: CaseJob) => boolean): Promise<number> {
    let n = 0;
    for (const e of this.jobs.values()) {
      if (!isTerminal(e) && !e.cancelRequested && match(e.job)) {
        e.cancelRequested = true;
        if (e.status === "queued") e.status = "cancelled";
        n++;
      }
    }
    return n;
  }

  async pending(owner: string, runnerId: string): Promise<number> {
    // A cancelling lease is on its way out, not pending work — the count excludes it with the terminals.
    return [...this.jobs.values()].filter(
      (e) => e.owner === owner && e.runnerId === runnerId && !isTerminal(e) && !e.cancelRequested,
    ).length;
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
  attempt_id: string | null; // job->>'attemptId', else current_attempt_id — that attempt's name (arch-review 52)
  activity_ms: string; // extract(epoch ...) comes back as a numeric string
}

export class PgRunnerJobStore implements RunnerJobStore {
  constructor(private readonly client: SqlClient) {}

  async park(input: ParkInput): Promise<void> {
    await this.client.query(
      // `current_attempt_id` is written HERE, at park (arch-review 51), not only by a re-lease's mint: the
      // column is how the dispatch's own attempt reaches the replica that later re-leases the job, and it was
      // NULL until a successor was minted — so the first mint read no predecessor and the dispatch's attempt
      // stood `executing` for ever beside the execution that replaced it.
      `INSERT INTO everdict_runner_jobs (job_id, owner, runner_id, tenant, job, required_caps, activity_at, current_attempt_id)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), $8)`,
      [
        input.jobId,
        input.owner,
        input.runnerId,
        input.tenant ?? null,
        JSON.stringify(input.job),
        input.requiredCaps,
        input.now,
        input.attemptId ?? null,
      ],
    );
  }

  async claim(input: ClaimInput): Promise<RunnerJobLease | null> {
    const claimed = await this.claimOn(this.client, input);
    return claimed ? claimed.lease : null;
  }

  // ── THE CLAIM TRANSACTION (arch-review 47 §5.1) ────────────────────────────────────────────────────
  //
  // The same three statements as `claim` (they are shared, not forked — a predicate that drifts between the
  // fenced path and the transactional one is a fence in name only), and then the ledger work INSIDE the same
  // transaction. The order is the point:
  //
  //   BEGIN → requeue sweep → cancelled sweep → candidate UPDATE (which also RETURNS the attempt the row
  //   currently names) → mint(predecessor superseded · new attempt inserted `executing` with the lease epoch)
  //   → job restamp + current_attempt_id → COMMIT
  //
  // The candidate UPDATE takes the row's lock, and it is held to COMMIT. So nothing can move the row under the
  // mint — no cancel, no expiry sweep, no competing claim — which is why the restamp below carries the
  // lease fence as a statement of what it relies on rather than as a race it could lose (see restampJob, whose
  // fence IS load-bearing because its claim committed long before).
  //
  // A throw anywhere inside rolls the whole thing back: the job returns to `queued` with no lease, no attempt
  // row and no restamp. That includes a ledger fault — with the ledger wired it is the ONLY ordinal authority,
  // and a re-lease it cannot record does not happen at all rather than running unrecorded. (A FIRST lease
  // touches the ledger not at all, so an outage never blocks fresh work; only re-leases wait for it.)
  async claimAttempt(input: ClaimInput, mint: ClaimAttemptMint): Promise<RunnerJobLease | null> {
    return withTransaction(this.client, "the runner lease claim (job + attempt ledger)", async (tx) => {
      const claimed = await this.claimOn(tx, input);
      if (!claimed) return null;
      const minted = await mint(claimed.lease, {
        attempts: new PgExecutionAttemptStore(tx),
        ...(claimed.priorAttemptId !== undefined ? { prior: claimed.priorAttemptId } : {}),
      });
      // Nothing to restamp: a first lease runs the attempt its dispatch opened, so the row's job is already
      // the one to hand out and a write here would only rewrite it with itself.
      if (minted.job === undefined && minted.attemptId === undefined) return claimed.lease;
      await tx.query(
        `UPDATE everdict_runner_jobs SET job = COALESCE($4::jsonb, job), current_attempt_id = COALESCE($5, current_attempt_id)
         WHERE job_id = $1 AND status = 'leased' AND leased_by = $2 AND lease_epoch = $3 AND lease_epoch > 0
           AND NOT cancel_requested`,
        [
          claimed.lease.jobId,
          input.runnerId,
          claimed.lease.leaseEpoch,
          minted.job !== undefined ? JSON.stringify(minted.job) : null,
          minted.attemptId ?? null,
        ],
      );
      return { ...claimed.lease, ...(minted.job !== undefined ? { job: minted.job } : {}) };
    });
  }

  private async claimOn(
    client: SqlClient,
    input: ClaimInput,
  ): Promise<{ lease: RunnerJobLease; priorAttemptId?: string } | null> {
    // Requeue this owner's expired leases (silent runner) before claiming. `NOT cancel_requested` on BOTH
    // statements: a cancelled job is neither requeued nor claimed. Without it the queue kept re-dispatching
    // work the control plane had already stopped — the in-memory hub's requeueExpired/orderLeasable have
    // always skipped a cancelled entry, and this is the store lane catching up to that guard.
    await client.query(
      `UPDATE everdict_runner_jobs SET status = 'queued', leased_by = NULL
       WHERE owner = $1 AND status = 'leased' AND NOT cancel_requested
         AND activity_at < to_timestamp($2 / 1000.0) - make_interval(secs => $3)`,
      [input.owner, input.now, input.leaseTtlMs / 1000],
    );
    // …and a CANCELLED expired lease terminalizes here instead of entering limbo (arch-review 47 P1-2):
    // excluded from the requeue above and from the claim below, ended by nothing — the sweep is the
    // non-compliant holder's reclaim.
    await client.query(
      `UPDATE everdict_runner_jobs SET status = 'cancelled'
       WHERE owner = $1 AND status = 'leased' AND cancel_requested
         AND activity_at < to_timestamp($2 / 1000.0) - make_interval(secs => $3)`,
      [input.owner, input.now, input.leaseTtlMs / 1000],
    );
    // Own queue before the owner pool (ORDER BY runner_id <> '*' DESC), FIFO; capability gate via array containment.
    // `current_attempt_id` comes back with the lease (mig 0183): the attempt this claim REPLACES, which the
    // transactional path supersedes and which nothing else on any replica could have told it about.
    const res = await client.query<{
      job_id: string;
      job: unknown;
      lease_epoch: number;
      current_attempt_id: string | null;
    }>(
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
       RETURNING job_id, job, lease_epoch, current_attempt_id`,
      [input.owner, input.runnerId, POOL_RUNNER, input.advertisedCaps ?? null, input.now],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      lease: { jobId: row.job_id, job: CaseJobSchema.parse(row.job), leaseEpoch: Number(row.lease_epoch) },
      ...(row.current_attempt_id !== null && row.current_attempt_id !== undefined
        ? { priorAttemptId: row.current_attempt_id }
        : {}),
    };
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
  // The Pg half of the same rule: one statement, the same predicate the CLAIM filters on (own queue or the
  // owner pool, not cancelled, `required_caps <@ advertised`), so a runner refreshes exactly the jobs it
  // could have taken instead (arch-review 119).
  async touchWaiting(input: {
    owner: string;
    runnerId: string;
    advertisedCaps?: string[];
    now: number;
  }): Promise<number> {
    const res = await this.client.query<{ job_id: string }>(
      `UPDATE everdict_runner_jobs SET activity_at = to_timestamp($4 / 1000.0)
        WHERE owner = $1 AND status = 'queued' AND NOT cancel_requested
          AND (runner_id = $2 OR runner_id = $3)
          AND ($5::text[] IS NULL OR required_caps <@ $5::text[])
          -- Monotonic: several replicas write this column and their clocks are not one clock, so a lagging
          -- one must not pull a job's liveness BACKWARDS into the timeout. It also turns a poll that would
          -- change nothing into no write at all, which is what keeps this cheap at the claim's poll rate.
          AND activity_at < to_timestamp($4 / 1000.0)
        RETURNING job_id`,
      [input.owner, input.runnerId, POOL_RUNNER, input.now, input.advertisedCaps ?? null],
    );
    return res.rows.length;
  }

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
          SET activity_at = CASE WHEN cancel_requested OR status = 'cancelled' THEN activity_at ELSE to_timestamp($4 / 1000.0) END
       WHERE job_id = $1 AND status IN ('leased', 'cancelled') AND leased_by = $2 AND lease_epoch = $3 AND lease_epoch > 0
       RETURNING cancel_requested, status`,
      [jobId, runnerId, leaseEpoch, now],
    );
    const row = res.rows[0];
    if (!row) return { extended: false, cancelled: false };
    // A terminal-cancelled row (the sweep/ack got there first) still answers its late holder — the reply is
    // the abort channel, and the holder's identity is still on the row (arch-review 47 P1-2).
    const cancelled = row.cancel_requested === true || (row as { status?: string }).status === "cancelled";
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
    if (res.rows.length === 0) await this.ackCancelled(jobId, ranBy, leaseEpoch);
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
    if (res.rows.length === 0) await this.ackCancelled(jobId, runnerId, leaseEpoch);
    return res.rows.length > 0;
  }

  // The cancelled holder's refused report IS its ack (arch-review 47 P1-2): lease identity matches, the
  // write was revoked, the row terminalizes — limbo is not a state.
  private async ackCancelled(jobId: string, runnerId: string, leaseEpoch: number): Promise<void> {
    await this.client.query(
      `UPDATE everdict_runner_jobs SET status = 'cancelled'
        WHERE job_id = $1 AND status = 'leased' AND leased_by = $2 AND lease_epoch = $3 AND lease_epoch > 0
          AND cancel_requested`,
      [jobId, runnerId, leaseEpoch],
    );
  }

  async expire(jobId: string): Promise<void> {
    await this.client.query(
      `UPDATE everdict_runner_jobs SET status = 'failed', error = $2
       WHERE job_id = $1 AND status IN ('queued', 'leased')`,
      [jobId, "no_runner: idle timeout (no lease/heartbeat activity)"],
    );
  }

  async outcome(jobId: string): Promise<RunnerJobOutcome | null> {
    // The attempt coordinate is projected OUT of the job document rather than parsing the whole CaseJob back:
    // this is the parking replica's poll loop (once per pollMs, per in-flight job), and only those two fields
    // are read. The NAME falls back to `current_attempt_id` — the mint writes both, and on a row whose restamp
    // is still the predecessor's the column is the more recent of the two (arch-review 52).
    const res = await this.client.query<JobRow>(
      `SELECT status, cancel_requested, result, error, leased_by, (job->>'recordingGeneration')::int AS recording_generation,
              COALESCE(job->>'attemptId', current_attempt_id) AS attempt_id,
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
      ...(row.attempt_id != null ? { attemptId: row.attempt_id } : {}),
      activityAt: Number(row.activity_ms),
    };
  }

  // A cancelled row reaches a persisted terminal state (arch-review 47 P1-2): a QUEUED row terminalizes in
  // the same statement (nobody holds it); a LEASED one keeps the flag — the runner must still HEAR the
  // cancel — and terminalizes on the holder's refused report (ack) or the claim-time TTL sweep.
  async cancel(match: (job: CaseJob) => boolean): Promise<number> {
    const res = await this.client.query<{ job_id: string; job: unknown; lease_epoch: number }>(
      `SELECT job_id, job FROM everdict_runner_jobs WHERE status IN ('queued', 'leased') AND NOT cancel_requested`,
    );
    const ids = res.rows.filter((r) => match(CaseJobSchema.parse(r.job))).map((r) => r.job_id);
    if (ids.length === 0) return 0;
    await this.client.query(
      `UPDATE everdict_runner_jobs
          SET cancel_requested = true,
              status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END
        WHERE job_id = ANY($1)`,
      [ids],
    );
    return ids.length;
  }

  async pending(owner: string, runnerId: string): Promise<number> {
    const res = await this.client.query<{ count: string }>(
      // A cancelling lease is on its way out, not pending work (arch-review 47 P1-2).
      "SELECT count(*)::text AS count FROM everdict_runner_jobs WHERE owner = $1 AND runner_id = $2 AND status IN ('queued', 'leased') AND NOT cancel_requested",
      [owner, runnerId],
    );
    return Number(res.rows[0]?.count ?? 0);
  }
}
