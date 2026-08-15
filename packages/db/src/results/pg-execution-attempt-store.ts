import type { ExecutionAttemptStore, OpenAttemptInput } from "@everdict/application-control";
import {
  type ExecutionAttemptRecord,
  ExecutionAttemptRecordSchema,
  type ExecutionAttemptState,
  InternalError,
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
    ...(row.error !== null && row.error !== undefined ? { error: row.error } : {}),
    openedAt: new Date(row.opened_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

const TERMINAL_LIST = TERMINAL_ATTEMPT_STATES.map((s) => `'${s}'`).join(", ");

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
         AND ($2 <> 'executing' OR state = 'created')
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
