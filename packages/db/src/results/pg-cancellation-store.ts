import type {
  CancellationCertificate,
  CancellationOperation,
  CancellationStore,
  CancellationTarget,
  CancellationTargetKind,
} from "@everdict/application-control";
import type { SqlClient } from "../client.js";

interface CancellationRow {
  scorecard_id: string;
  target_kind: string;
  state: string;
  last_error: string | null;
  requested_at: string | Date;
  completed_at: string | Date | null;
  certificate: unknown;
  verification_attempts?: number | null;
  escalated_at?: string | Date | null;
  next_attempt_at?: string | Date | null;
}

// The row's `state` is a column this adapter writes and nothing else does, so the only way it can hold a
// string outside the vocabulary is a hand-edited database. The reconciler treats anything that is not
// terminal as owed (the WHERE clause below), which is the fail-safe direction: an unrecognizable state gets
// one more idempotent teardown rather than a silently abandoned operation. `completed` is the ONE terminal
// state (arch-review 54, Phase 5); `unverifiable` is read only because rows written before mig 0190 carry it.
//
// `target_kind` is read the other way round — an UNRECOGNIZED kind stays unrecognized (it is passed through
// as-is and the coordinator finds no teardown for it, leaving the row owed). Coercing it to "scorecard"
// would hand a run's teardown to the batch lane, which would then close it as unactionable over live work.
function toOperation(row: CancellationRow): CancellationOperation {
  return {
    target: { kind: row.target_kind as CancellationTargetKind, id: row.scorecard_id },
    state:
      row.state === "completed"
        ? "completed"
        : row.state === "unverifiable"
          ? "unverifiable" // pre-0190 rows; 0190 re-opened them as `verifying`, so this is history only
          : row.state === "verifying"
            ? "verifying"
            : "requested",
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    requestedAt: new Date(row.requested_at).toISOString(),
    ...(row.completed_at !== null ? { completedAt: new Date(row.completed_at).toISOString() } : {}),
    ...(row.certificate !== null && row.certificate !== undefined
      ? { certificate: row.certificate as CancellationCertificate }
      : {}),
    ...(row.verification_attempts ? { verificationAttempts: row.verification_attempts } : {}),
    // The ALERT, read back beside the debt (arch-review 54, Phase 5).
    ...(row.escalated_at !== null && row.escalated_at !== undefined
      ? {
          escalation: {
            kind: "unverifiable" as const,
            attempts: row.verification_attempts ?? 0,
            alertedAt: new Date(row.escalated_at).toISOString(),
            requiresOperator: true as const,
          },
        }
      : {}),
    ...(row.next_attempt_at !== null && row.next_attempt_at !== undefined
      ? { nextAttemptAt: new Date(row.next_attempt_at).toISOString() }
      : {}),
  };
}

// Postgres-backed cancellation-operation ledger (mig 0184; generalized to any target kind by mig 0186). See
// ports/cancellation-store.ts for what this row is: the teardown's durable owner, separate from the decision
// it follows. The id column keeps its original name — the table predates the second kind, and renaming a
// column an in-flight replica is still writing buys nothing the `target_kind` beside it does not already say.
export class PgCancellationStore implements CancellationStore {
  constructor(private readonly client: SqlClient) {}

  // `requested_at` is NOT overwritten on conflict: a re-request is the same operation being attempted again,
  // and the reconciler orders by age. `last_error` and `certificate` ARE cleared — both described the
  // attempt that just ended, and a certificate left behind would outlive the completion it certified.
  async request(target: CancellationTarget, now: string): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_cancellation_operations (scorecard_id, target_kind, state, requested_at)
       VALUES ($1, $2, 'requested', $3)
       ON CONFLICT (scorecard_id) DO UPDATE
         SET state = 'requested', target_kind = $2, last_error = NULL, completed_at = NULL, certificate = NULL`,
      [target.id, target.kind, now],
    );
  }

  // Unconditional rather than "only from requested": completing an operation is idempotent, and a guard here
  // would mean a reconciler and a retrying caller finishing the same teardown could leave the row owed.
  async complete(target: CancellationTarget, now: string, certificate?: CancellationCertificate): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_cancellation_operations (scorecard_id, target_kind, state, requested_at, completed_at, certificate)
       VALUES ($1, $2, 'completed', $3, $3, $4)
       ON CONFLICT (scorecard_id) DO UPDATE
         SET state = 'completed', target_kind = $2, last_error = NULL, completed_at = $3, certificate = $4`,
      [target.id, target.kind, now, certificate === undefined ? null : JSON.stringify(certificate)],
    );
  }

  async fail(
    target: CancellationTarget,
    error: string,
    now: string,
    state: "requested" | "verifying" = "requested",
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_cancellation_operations (scorecard_id, target_kind, state, last_error, requested_at)
       VALUES ($1, $2, $5, $3, $4)
       ON CONFLICT (scorecard_id) DO UPDATE
         SET state = $5,
             target_kind = $2,
             last_error = $3,
             completed_at = NULL,
             certificate = NULL,
             -- The budget is counted on the ROW (arch-review 53, Wave E): retries are spread across
             -- replicas, and a reconciler that restarted would otherwise begin counting again.
             verification_attempts = everdict_cancellation_operations.verification_attempts
               + CASE WHEN $5 = 'verifying' THEN 1 ELSE 0 END`,
      [target.id, target.kind, error, now, state],
    );
  }

  // OWED, with the alert raised (arch-review 54, Phase 5) — see the port. It stays `verifying`: the stops ran
  // and the world did not come back quiet, which is the truth whether or not anyone has been told.
  async escalate(
    target: CancellationTarget,
    reason: string,
    now: string,
    nextAttemptAt: string,
    attempts: number,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_cancellation_operations
         (scorecard_id, target_kind, state, last_error, requested_at, escalated_at, next_attempt_at, verification_attempts)
       VALUES ($1, $2, 'verifying', $3, $4, $4, $5, $6)
       ON CONFLICT (scorecard_id) DO UPDATE
         SET state = 'verifying', target_kind = $2, last_error = $3,
             escalated_at = COALESCE(everdict_cancellation_operations.escalated_at, $4),
             next_attempt_at = $5,
             verification_attempts = $6,
             completed_at = NULL`,
      [target.id, target.kind, reason, now, nextAttemptAt, attempts],
    );
  }

  async listIncomplete(limit: number): Promise<CancellationOperation[]> {
    const { rows } = await this.client.query<CancellationRow>(
      `SELECT * FROM everdict_cancellation_operations
        -- Everything still OWED, and only 'completed' is terminal (arch-review 54, Phase 5). 'unverifiable'
        -- used to be excluded here, which took the one loop that could ever retry it away from an operation
        -- whose compute may still be running. It is an escalation now, recorded on an owed row.
        --
        -- A row with a future next_attempt_at is being backed off, not ignored: the escalation slows the
        -- retries so an unreachable cluster is not re-swept every cycle.
        WHERE state <> 'completed'
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY requested_at
        LIMIT $1`,
      [limit],
    );
    return rows.map(toOperation);
  }

  // Keyed on the id AND the kind: a row for a different kind of target is not this operation, and answering
  // with it would let a run's incomplete teardown block a same-id batch's delete (or, worse, the reverse).
  async get(target: CancellationTarget): Promise<CancellationOperation | undefined> {
    const { rows } = await this.client.query<CancellationRow>(
      "SELECT * FROM everdict_cancellation_operations WHERE scorecard_id = $1 AND target_kind = $2",
      [target.id, target.kind],
    );
    return rows[0] ? toOperation(rows[0]) : undefined;
  }
}
