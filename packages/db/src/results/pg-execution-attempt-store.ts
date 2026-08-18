import type { ExecutionAttemptStore, OpenAttemptInput } from "@everdict/application-control";
import {
  ConflictError,
  type ExecutionAttemptRecord,
  ExecutionAttemptRecordSchema,
  type ExecutionAttemptState,
  InternalError,
  NotFoundError,
  OPEN_RUN_STATUSES,
  OPEN_SCORECARD_STATUSES,
  type PersistedWorkIntent,
  type RuntimeWorkRef,
  RuntimeWorkRefSchema,
  TERMINAL_ATTEMPT_STATES,
  attemptIdOf,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";

interface AttemptRow {
  attempt_id: string;
  execution_id: string;
  generation: number;
  tenant: string;
  scorecard_id: string | null;
  case_id: string | null;
  trial: number | null;
  child_run_id: string | null;
  driver_epoch: string | number | null;
  lease_epoch: number | null;
  state: string;
  unisolated: boolean;
  runtime_work: unknown;
  error: unknown;
  opened_at: string | Date;
  updated_at: string | Date;
}

function toAttempt(row: AttemptRow): ExecutionAttemptRecord {
  // Validated at the boundary, not cast: an unknown `state` in the column is a row this ledger cannot
  // describe, and the schema is the one place that decides what the vocabulary is.
  return ExecutionAttemptRecordSchema.parse({
    attemptId: row.attempt_id,
    executionId: row.execution_id,
    generation: Number(row.generation),
    tenant: row.tenant,
    ...(row.scorecard_id !== null ? { scorecardId: row.scorecard_id } : {}),
    ...(row.case_id !== null ? { caseId: row.case_id } : {}),
    ...(row.trial !== null ? { trial: Number(row.trial) } : {}),
    ...(row.child_run_id !== null ? { childRunId: row.child_run_id } : {}),
    ...(row.driver_epoch !== null ? { driverEpoch: Number(row.driver_epoch) } : {}),
    ...(row.lease_epoch !== null ? { leaseEpoch: Number(row.lease_epoch) } : {}),
    state: row.state,
    unisolated: row.unisolated,
    ...(row.runtime_work !== null && row.runtime_work !== undefined ? { runtimeWork: row.runtime_work } : {}),
    ...(row.error !== null && row.error !== undefined ? { error: row.error } : {}),
    openedAt: new Date(row.opened_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

const TERMINAL_LIST = TERMINAL_ATTEMPT_STATES.map((s) => `'${s}'`).join(", ");
// ── THE PARENT-AUTHORITY VOCABULARY, GENERATED (arch-review 56, Wave A) ─────────────────────────────
//
// The reservation's parent condition was hand-written as `NOT IN ('succeeded', 'failed')`, which is fail-OPEN:
// it was true of the enum on the day it was written, and `superseded` and `cancelled` (scorecards) and
// `suspended` (runs) joined afterwards, so the guard answered "this parent may still place compute" for a
// batch the user had cancelled. Generated from the shared allowlist instead, so the SQL cannot say something
// the domain does not — and a status added tomorrow is excluded until somebody classifies it.
const OPEN_SCORECARDS = OPEN_SCORECARD_STATUSES.map((s) => `'${s}'`).join(", ");
const OPEN_RUNS = OPEN_RUN_STATUSES.map((s) => `'${s}'`).join(", ");

// ── "MAY THIS ATTEMPT STILL AUTHORIZE WORK?", WRITTEN ONCE (arch-review 56, Wave D) ─────────────────
//
// Used by the guarded UPDATE and by the idempotent re-reservation's read, because those two used to be a
// condition and a shortcut PAST it: the retry path returned a stored intent having asked nothing, so a
// cancelled parent re-authorized the very work its teardown had converged on. One fragment, both places.
const PARENT_AUTHORIZES = `(
           a.scorecard_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM everdict_scorecards s
              WHERE s.id = a.scorecard_id
                AND s.status IN (${OPEN_SCORECARDS})
                AND (a.driver_epoch IS NULL OR s.owner_epoch = a.driver_epoch)
           )
           OR a.scorecard_id IS NULL AND EXISTS (
             SELECT 1 FROM everdict_runs r
              WHERE 'evd-run-' || r.id = a.execution_id
                AND r.status IN (${OPEN_RUNS})
                AND (a.driver_epoch IS NULL OR r.owner_epoch = a.driver_epoch)
           )
         )`;

// Postgres-backed physical-execution ledger (mig 0182). See ports/execution-attempt-store.ts for what this
// plane is and is not: a Phase-1 dual-write audit spine, observed rather than depended on.
export class PgExecutionAttemptStore implements ExecutionAttemptStore {
  constructor(private readonly client: SqlClient) {}

  // ONE STATEMENT, because a mint that reads first is not a mint. The ordinal is computed and claimed
  // together, so two concurrent openers of one execution cannot both read the same MAX and both insert it —
  // the UNIQUE (execution_id, generation) refuses the second, which is what makes the retry below correct
  // rather than a way of eventually agreeing with a race.
  async open(input: OpenAttemptInput): Promise<{ attemptId: string; generation: number }> {
    try {
      return await this.insertNext(input);
    } catch (err) {
      // A lost race is ORDINARY here (a spillover duplicate and its straggler open within milliseconds of
      // each other), and the loser's answer is simply the next ordinal — recomputed, since the winner's row
      // is now committed and visible. Retried ONCE: a second collision means something other than a race,
      // and quietly looping would turn a store fault into an unbounded one.
      if ((err as { code?: string }).code !== "23505") throw err;
      return await this.insertNext(input);
    }
  }

  private async insertNext(input: OpenAttemptInput): Promise<{ attemptId: string; generation: number }> {
    const { rows } = await this.client.query<{ attempt_id: string; generation: number }>(
      `INSERT INTO everdict_execution_attempts
         (attempt_id, execution_id, generation, tenant, scorecard_id, case_id, trial, child_run_id,
          driver_epoch, state, opened_at, updated_at)
       SELECT $1 || '#g' || (COALESCE(MAX(generation), 0) + 1)::text, $1, COALESCE(MAX(generation), 0) + 1,
              $2, $3, $4, $5, $6, $7, 'created', now(), now()
         FROM everdict_execution_attempts WHERE execution_id = $1
       RETURNING attempt_id, generation`,
      [
        input.executionId,
        input.tenant,
        input.scorecardId ?? null,
        input.caseId ?? null,
        input.trial ?? null,
        input.childRunId ?? null,
        input.driverEpoch ?? null,
      ],
    );
    const row = rows[0];
    // Nothing deletes attempts, so an insert that returns no row is a store fault rather than an ordinal to
    // invent — the same refusal the recording store's open makes, for the same reason.
    if (!row)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { executionId: input.executionId },
        "execution attempt was not opened — the insert returned no row",
      );
    // The id the statement built and the id the rest of the system spells are the same string BY CONSTRUCTION
    // here — asserted rather than assumed, because a divergence would make every downstream stamp address a
    // row that does not exist.
    const generation = Number(row.generation);
    const attemptId = attemptIdOf(input.executionId, generation);
    if (row.attempt_id !== attemptId)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { executionId: input.executionId, generation },
        "execution attempt id disagrees with the canonical spelling",
      );
    return { attemptId, generation };
  }

  // The state machine, expressed as the WHERE clause of one UPDATE — first terminal wins, and "executing"
  // only from "created". No row updated means the transition was refused, which is a no-op and not an error
  // (a late report from a superseded attempt is the ordinary case).
  async transition(
    attemptId: string,
    to: ExecutionAttemptState,
    patch?: {
      childRunId?: string;
      leaseEpoch?: number;
      unisolated?: boolean;
      error?: { code: string; message: string };
    },
  ): Promise<boolean> {
    const { rows } = await this.client.query<{ attempt_id: string }>(
      `UPDATE everdict_execution_attempts SET
         state = $2,
         child_run_id = COALESCE($3, child_run_id),
         lease_epoch = COALESCE($4::int, lease_epoch),
         unisolated = COALESCE($5::boolean, unisolated),
         error = COALESCE($6::jsonb, error),
         updated_at = now()
       WHERE attempt_id = $1
         AND state NOT IN (${TERMINAL_LIST})
         AND $2 <> 'created'
         AND ($2 <> 'executing' OR state IN ('created', 'reserved'))
       RETURNING attempt_id`,
      [
        attemptId,
        to,
        patch?.childRunId ?? null,
        patch?.leaseEpoch ?? null,
        patch?.unisolated ?? null,
        patch?.error ? JSON.stringify(patch.error) : null,
      ],
    );
    return rows.length > 0;
  }

  // ── THE RESERVATION IS A CONDITIONAL TRANSITION (arch-review 55, Wave 1) ──────────────────────────
  //
  // It was `WHERE attempt_id = $1` — which proves the row EXISTS and asks nothing about whether this caller
  // may still act. So it authorized a superseded attempt, a driver a takeover had displaced, and a batch the
  // user had cancelled a second earlier: each can no longer commit an outcome, and each could still bring new
  // compute into existence that the cancellation racing it would never see.
  //
  // One statement asserts all of it, because a check followed by a write is the window itself:
  //   • `state = 'created'` — an attempt whose story is over places nothing;
  //   • `runtime_work IS NULL` — one attempt authorizes ONE piece of work (the same-id retry is handled
  //     above the statement, so a caller repeating itself is idempotent rather than refused);
  //   • the parent is still OPEN and still at the epoch this attempt was opened under — a correlated EXISTS
  //     over the scorecard (batch children) or the run (standalone), matched on `driver_epoch`.
  //
  // A `driver_epoch` of NULL means the lane never claimed one (the single-process CLI); those rows keep the
  // liveness half and skip the epoch comparison, which is what "we cannot check what nobody recorded" means
  // here — never a licence.
  //
  // `RETURNING` is still the proof the backend is handed (arch-review 54, Phase 1): zero rows means this
  // dispatch has no durable identity OR no remaining authority, and both must stop it.
  async reserveWork(attemptId: string, work: RuntimeWorkRef): Promise<PersistedWorkIntent> {
    // The idempotent re-reservation, asked first: a retry that re-offers the SAME external id is repeating
    // itself, and the guarded UPDATE below would refuse it for `runtime_work IS NULL`.
    const { rows: existing } = await this.client.query<{
      runtime_work: unknown;
      updated_at: string;
      authorized: boolean;
    }>(
      `SELECT a.runtime_work, a.updated_at, ${PARENT_AUTHORIZES} AS authorized
         FROM everdict_execution_attempts a
        WHERE a.attempt_id = $1`,
      [attemptId],
    );
    const held = existing[0];
    if (held === undefined)
      throw new NotFoundError(
        "NOT_FOUND",
        { attemptId },
        "cannot reserve runtime work against an attempt row that does not exist — the dispatch has no durable identity to place work under.",
      );
    if (held.runtime_work !== null && held.runtime_work !== undefined) {
      const reserved = RuntimeWorkRefSchema.parse(held.runtime_work);
      if (reserved.externalJobId === work.externalJobId) {
        // …AND THE AUTHORITY IS RE-ASKED (arch-review 56, Wave D). Same identity is a reason to hand back the
        // SAME handle rather than mint a second one; it is not a reason to skip the question. A proof has a
        // lifetime (L1), and this path used to return one minted from a memory.
        if (!held.authorized)
          throw new ConflictError(
            "CONFLICT",
            { attemptId },
            "this attempt may no longer authorize work — the execution it belongs to has ended or is owned by a newer driver, so re-offering the same handle does not revive the authorization.",
          );
        return {
          attemptId,
          work: reserved,
          persistedAt: typeof held.updated_at === "string" ? held.updated_at : new Date(held.updated_at).toISOString(),
        };
      }
      throw new ConflictError(
        "CONFLICT",
        { attemptId, reserved: reserved.externalJobId, offered: work.externalJobId },
        "this attempt has already authorized other work — overwriting the handle would leave the running job unaddressable.",
      );
    }
    const { rows } = await this.client.query<{ runtime_work: unknown; updated_at: string }>(
      `UPDATE everdict_execution_attempts a SET
         runtime_work = $2::jsonb,
         state = 'reserved',
         updated_at = now()
       WHERE a.attempt_id = $1
         AND a.state = 'created'
         AND a.runtime_work IS NULL
         AND ${PARENT_AUTHORIZES}
       RETURNING runtime_work, updated_at`,
      [attemptId, JSON.stringify(work)],
    );
    const row = rows[0];
    if (!row)
      throw new ConflictError(
        "CONFLICT",
        { attemptId },
        "this attempt may no longer authorize work — it has ended, already reserved, or belongs to an execution this driver no longer owns.",
      );
    // Read back from the write rather than echoing the argument: what the ledger holds is what a teardown
    // will address, and a caller told otherwise would stop something that was never recorded.
    return {
      attemptId,
      work: RuntimeWorkRefSchema.parse(row.runtime_work),
      persistedAt: typeof row.updated_at === "string" ? row.updated_at : new Date(row.updated_at).toISOString(),
    };
  }

  // Unconditional on purpose: the fence this records could not be raised at ANY point in the attempt's life,
  // and refusing to record that on a terminal row would lose the fact precisely when it matters most.
  async markUnisolated(attemptId: string): Promise<void> {
    await this.client.query(
      "UPDATE everdict_execution_attempts SET unisolated = true, updated_at = now() WHERE attempt_id = $1",
      [attemptId],
    );
  }

  async list(executionId: string): Promise<ExecutionAttemptRecord[]> {
    const { rows } = await this.client.query<AttemptRow>(
      "SELECT * FROM everdict_execution_attempts WHERE execution_id = $1 ORDER BY generation",
      [executionId],
    );
    return rows.map(toAttempt);
  }

  async listForScorecard(scorecardId: string): Promise<ExecutionAttemptRecord[]> {
    const { rows } = await this.client.query<AttemptRow>(
      "SELECT * FROM everdict_execution_attempts WHERE scorecard_id = $1 ORDER BY execution_id, generation",
      [scorecardId],
    );
    return rows.map(toAttempt);
  }
}
