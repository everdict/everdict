import type { CancellationOperation, CancellationStore } from "@everdict/application-control";
import type { SqlClient } from "../client.js";

interface CancellationRow {
  scorecard_id: string;
  state: string;
  last_error: string | null;
  requested_at: string | Date;
  completed_at: string | Date | null;
}

// The row's `state` is a column this adapter writes and nothing else does, so the only way it can hold a
// string outside the vocabulary is a hand-edited database. The reconciler treats anything that is not
// "completed" as owed (the WHERE clause below), which is the fail-safe direction: an unrecognizable state
// gets one more idempotent teardown rather than a silently abandoned operation.
function toOperation(row: CancellationRow): CancellationOperation {
  return {
    scorecardId: row.scorecard_id,
    state: row.state === "completed" ? "completed" : "requested",
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    requestedAt: new Date(row.requested_at).toISOString(),
    ...(row.completed_at !== null ? { completedAt: new Date(row.completed_at).toISOString() } : {}),
  };
}

// Postgres-backed cancellation-operation ledger (mig 0184). See ports/cancellation-store.ts for what this
// row is: the teardown's durable owner, separate from the decision it follows.
export class PgCancellationStore implements CancellationStore {
  constructor(private readonly client: SqlClient) {}

  // `requested_at` is NOT overwritten on conflict: a re-request is the same operation being attempted again,
  // and the reconciler orders by age. `last_error` IS cleared — it described the attempt that just ended.
  async request(scorecardId: string, now: string): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_cancellation_operations (scorecard_id, state, requested_at)
       VALUES ($1, 'requested', $2)
       ON CONFLICT (scorecard_id) DO UPDATE
         SET state = 'requested', last_error = NULL, completed_at = NULL`,
      [scorecardId, now],
    );
  }

  // Unconditional rather than "only from requested": completing an operation is idempotent, and a guard here
  // would mean a reconciler and a retrying caller finishing the same teardown could leave the row owed.
  async complete(scorecardId: string, now: string): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_cancellation_operations (scorecard_id, state, requested_at, completed_at)
       VALUES ($1, 'completed', $2, $2)
       ON CONFLICT (scorecard_id) DO UPDATE
         SET state = 'completed', last_error = NULL, completed_at = $2`,
      [scorecardId, now],
    );
  }

  async fail(scorecardId: string, error: string, now: string): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_cancellation_operations (scorecard_id, state, last_error, requested_at)
       VALUES ($1, 'requested', $2, $3)
       ON CONFLICT (scorecard_id) DO UPDATE
         SET state = 'requested', last_error = $2, completed_at = NULL`,
      [scorecardId, error, now],
    );
  }

  async listIncomplete(limit: number): Promise<CancellationOperation[]> {
    const { rows } = await this.client.query<CancellationRow>(
      `SELECT * FROM everdict_cancellation_operations
        WHERE state <> 'completed'
        ORDER BY requested_at
        LIMIT $1`,
      [limit],
    );
    return rows.map(toOperation);
  }

  async get(scorecardId: string): Promise<CancellationOperation | undefined> {
    const { rows } = await this.client.query<CancellationRow>(
      "SELECT * FROM everdict_cancellation_operations WHERE scorecard_id = $1",
      [scorecardId],
    );
    return rows[0] ? toOperation(rows[0]) : undefined;
  }
}
