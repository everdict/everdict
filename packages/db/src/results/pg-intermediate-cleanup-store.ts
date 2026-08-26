import type {
  ArtifactRef,
  IntermediateCleanupDebt,
  IntermediateCleanupStore,
  ReleasedCleanup,
} from "@everdict/application-control";
import { type ExecutionId, InternalError } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// ── THE CLEANUP DEBT, DURABLE (arch-review 68; mig 0193) ────────────────────────────────────────────
//
// The in-memory twin closed the ordinary path — a case that settles in this process discharges exactly what
// it staged, on every ending. What it could not close is the one the ledger exists for: a control plane that
// dies between the staging and the settlement leaks its artifacts forever, because the only record of what
// was owed died with it.
//
// Every method here is one statement, for the reason the attempt ledger's are: a read followed by a write is
// the window the write exists to close, and this row is contended by the settlement (releasing) and the
// reconciler (collecting) at the same time.
interface CleanupRow {
  operation_id: string;
  tenant: string;
  execution_id: string;
  refs: unknown;
  state: string;
  attempts: string | number;
  next_attempt_at: string | Date | null;
  last_error: string | null;
}

// The vocabulary is closed by the port's union; this only narrows the column to it and refuses anything else,
// which is the same posture `toAttempt` takes (validate at the boundary, never cast past it).
const LIFECYCLE = new Set(["retained", "gc_owed", "retry_wait", "completed"]);

function toDebt(row: CleanupRow): IntermediateCleanupDebt {
  if (!LIFECYCLE.has(row.state))
    throw new InternalError(
      "UPSTREAM_ERROR",
      { operationId: row.operation_id, state: row.state },
      "the cleanup ledger holds a lifecycle state this version cannot describe",
    );
  return {
    operationId: row.operation_id,
    tenant: row.tenant,
    executionId: row.execution_id as ExecutionId,
    refs: (row.refs as ArtifactRef[]) ?? [],
    state: row.state as IntermediateCleanupDebt["state"],
    attempts: Number(row.attempts),
    ...(row.next_attempt_at !== null ? { nextAttemptAt: new Date(row.next_attempt_at).toISOString() } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  };
}

// The row's own name, minted from the coordinate the settlement addresses it by. Two stagings of one
// execution converge on this rather than opening a second row — which is what makes `owe` idempotent and
// what lets the reconciler's backoff address a debt it has already seen.
const operationIdOf = (tenant: string, executionId: string): string => `gc/${tenant}/${executionId}`;

export class PgIntermediateCleanupStore implements IntermediateCleanupStore {
  constructor(private readonly client: SqlClient) {}

  // ACCUMULATING, and RETAINED. The two halves are staged at different moments and the second call must not
  // forget the first, so the refs are merged in SQL rather than read-modify-written across a round trip.
  //
  // …and a re-stage after a completed sweep RE-OPENS the debt: new bytes exist and the case that wrote them
  // is not finished, whatever happened to the older ones.
  async owe(input: {
    tenant: string;
    executionId: ExecutionId;
    refs: ArtifactRef[];
  }): Promise<IntermediateCleanupDebt> {
    const { rows } = await this.client.query<CleanupRow>(
      `INSERT INTO everdict_intermediate_cleanup (operation_id, tenant, execution_id, refs, state)
       VALUES ($1, $2, $3, $4::jsonb, 'retained')
       ON CONFLICT (operation_id) DO UPDATE SET
         -- Deduplicated by key: a retry re-staging the same object owes it once. The incoming ref wins on a
         -- key collision, because it is the one whose bytes were just written.
         refs = (
           SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) FROM (
             SELECT DISTINCT ON (r ->> 'key') r
               FROM jsonb_array_elements($4::jsonb || everdict_intermediate_cleanup.refs) AS r
              ORDER BY r ->> 'key', (r ->> 'written') NULLS LAST
           ) AS merged
         ),
         -- ── …BUT NOT BACK INTO RETENTION ONCE THE EXECUTION HAS SETTLED (arch-review 70 P1) ────────
         -- retained means "a recovery may still need these bytes", which stops being true at the
         -- settlement. A speculative LOSER staging after the winner completed used to flip this row back and
         -- then release nothing, and due() never returns a retained row. A late stage is owed COLLECTABLE.
         -- (No backticks in here: this is inside a JS template literal and one would close the string. Same
         -- trap as arch-review 67, hit again in 70.)
         state = CASE WHEN everdict_intermediate_cleanup.state = 'retained' THEN 'retained' ELSE 'gc_owed' END,
         next_attempt_at = NULL,
         updated_at = now()
       RETURNING *`,
      [operationIdOf(input.tenant, input.executionId), input.tenant, input.executionId, JSON.stringify(input.refs)],
    );
    const row = rows[0];
    // A decision rests on this (rule `protocol` L1): the staging proceeds to hand bytes to a lane that will
    // reclaim the container, so "the debt was recorded" must be evidence rather than an assumption.
    if (!row)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { tenant: input.tenant, executionId: input.executionId },
        "the cleanup debt was not recorded — the upsert returned no row",
      );
    return toDebt(row);
  }

  // …and confirmed AFTER the put, so a sweep can tell an object that exists from one whose write never
  // landed. Without it the owe-before-put ordering lets a reconciler delete an absent key, mark the debt
  // paid, and orphan the write still in flight behind it.
  async confirm(input: { tenant: string; executionId: ExecutionId; keys: string[] }): Promise<void> {
    await this.client.query(
      `UPDATE everdict_intermediate_cleanup SET
         refs = (
           SELECT COALESCE(jsonb_agg(
             CASE WHEN r ->> 'key' = ANY($3::text[]) THEN r || '{"written":true}'::jsonb ELSE r END
           ), '[]'::jsonb)
           FROM jsonb_array_elements(refs) AS r
         ),
         -- …and a confirm arriving AFTER the sweep re-opens the debt (arch-review 71 P1). owe precedes the
         -- put, so a writer can be paused between them; the sweep probes an absent key, correctly closes the
         -- debt, and then the put lands. Bytes proven to exist under a settled debt are collectable NOW.
         state = CASE WHEN everdict_intermediate_cleanup.state = 'retained' THEN 'retained' ELSE 'gc_owed' END,
         updated_at = now()
       WHERE operation_id = $1 AND tenant = $2`,
      [operationIdOf(input.tenant, input.executionId), input.tenant, input.keys],
    );
  }

  // THE SETTLEMENT'S RELEASE. Until this runs the artifacts are retained and no sweep may remove them.
  // Returns what became collectable so the caller can delete inline as a latency optimization — the
  // reconciler is the correctness owner either way.
  async releaseForGc(tenant: string, executionId: ExecutionId): Promise<ReleasedCleanup | undefined> {
    const { rows } = await this.client.query<CleanupRow>(
      `UPDATE everdict_intermediate_cleanup SET state = 'gc_owed', next_attempt_at = NULL, updated_at = now()
        WHERE operation_id = $1 AND tenant = $2 AND state <> 'completed'
        RETURNING *`,
      [operationIdOf(tenant, executionId), tenant],
    );
    const row = rows[0];
    // The row's OWN operation id travels back with the refs. The caller used to re-derive it as
    // `gc-${executionId}` while this adapter mints `gc/${tenant}/${executionId}`, so every inline-cleanup
    // failure deferred against a row that did not exist (arch-review 69 P2).
    if (!row) return undefined;
    const debt = toDebt(row);
    return { operationId: debt.operationId, refs: debt.refs };
  }

  // Only a RELEASED debt may be completed. Refusing from `retained` is the guard that keeps a stray caller
  // from marking an artifact collected while the case that needs it is still running.
  async complete(tenant: string, executionId: ExecutionId): Promise<boolean> {
    const { rows } = await this.client.query<{ operation_id: string }>(
      `UPDATE everdict_intermediate_cleanup SET state = 'completed', updated_at = now()
        WHERE operation_id = $1 AND tenant = $2 AND state IN ('gc_owed', 'retry_wait')
        RETURNING operation_id`,
      [operationIdOf(tenant, executionId), tenant],
    );
    return rows.length > 0;
  }

  // The reconciler's worklist — RELEASED debts only. A `retained` row is an artifact the case may still need,
  // and returning it here is what would turn this ledger from a cleanup into a way of destroying the recovery
  // it exists to enable.
  async due(now: string, limit: number): Promise<IntermediateCleanupDebt[]> {
    const { rows } = await this.client.query<CleanupRow>(
      `SELECT * FROM everdict_intermediate_cleanup
        WHERE state IN ('gc_owed', 'retry_wait')
          AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz)
        ORDER BY next_attempt_at NULLS FIRST, created_at
        LIMIT $2`,
      [now, limit],
    );
    return rows.map(toDebt);
  }

  // The rows no settlement will ever release (arch-review 71, migration). A row written before the release
  // rode the settlement transaction can be `retained` on an execution that is already terminal: its
  // settlement committed and the separate release call never ran. `due()` correctly refuses to return them,
  // which is what keeps them forever.
  //
  // Age-filtered because a LIVE case is legitimately retained for as long as it runs: anything recent is a
  // case in flight, not a leak. Candidates only — the sweeper reads the execution's terminal state before
  // it flips anything.
  async staleRetained(olderThan: string, limit: number): Promise<IntermediateCleanupDebt[]> {
    const { rows } = await this.client.query<CleanupRow>(
      `SELECT * FROM everdict_intermediate_cleanup
        WHERE state = 'retained' AND updated_at <= $1::timestamptz
        ORDER BY updated_at
        LIMIT $2`,
      [olderThan, limit],
    );
    return rows.map(toDebt);
  }

  // A deletion that did not converge. Backoff and an attempt count an operator can read — never a terminal:
  // "we could not find out" is an escalation field (rule `protocol` L5), so the row stays owed.
  async deferred(operationId: string, error: string, nextAttemptAt: string): Promise<void> {
    await this.client.query(
      `UPDATE everdict_intermediate_cleanup SET
         state = 'retry_wait', attempts = attempts + 1, last_error = $2,
         next_attempt_at = $3::timestamptz, updated_at = now()
       WHERE operation_id = $1`,
      [operationId, error, nextAttemptAt],
    );
  }
}
