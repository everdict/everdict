import type { PublicationOperation } from "@everdict/contracts";
import { PublicationOperationSchema } from "@everdict/contracts";

import type { PublicationOperationStore } from "@everdict/application-control";
import type { SqlClient } from "../client.js";

// The row shape — see mig 0188 for why the operations live in their own table rather than in a column on the
// scorecard, and why a publisher claims by operation id instead of by "whatever is pending".
interface Row {
  id: string;
  scorecard_id: string;
  scoring_revision: number;
  pass_id: string;
  state: string;
  effects: unknown;
  planned_at: string | Date;
  published_at: string | Date | null;
  last_error: string | null;
  claimed_by: string | null;
  lease_until: string | Date | null;
}

const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value);

function toOperation(row: Row): PublicationOperation {
  return PublicationOperationSchema.parse({
    id: row.id,
    settlement: { scorecardId: row.scorecard_id, scoringRevision: row.scoring_revision, passId: row.pass_id },
    state: row.state,
    effects: row.effects,
    plannedAt: iso(row.planned_at),
    ...(row.published_at !== null ? { publishedAt: iso(row.published_at) } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    ...(row.claimed_by !== null ? { claimedBy: row.claimed_by } : {}),
    ...(row.lease_until !== null ? { leaseUntil: iso(row.lease_until) } : {}),
  });
}

export class PgPublicationOperationStore implements PublicationOperationStore {
  constructor(private readonly client: SqlClient) {}

  async open(operation: PublicationOperation): Promise<void> {
    // ON CONFLICT DO NOTHING is the deduplication: two replicas settling the same pass compute the same id,
    // and one debt is what that decision owes.
    await this.client.query(
      `INSERT INTO everdict_publication_operations
         (id, scorecard_id, scoring_revision, pass_id, state, effects, planned_at, last_error)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        operation.id,
        operation.settlement.scorecardId,
        operation.settlement.scoringRevision,
        operation.settlement.passId,
        operation.state,
        JSON.stringify(operation.effects),
        operation.plannedAt,
        operation.lastError ?? null,
      ],
    );
  }

  async claim(id: string, owner: string, leaseSeconds: number, now: string): Promise<PublicationOperation | undefined> {
    // The claim IS the fence — one statement, so two publishers cannot both pass it. A live lease belongs to
    // somebody else; an expired one is reclaimable, which is how a publisher that died mid-drain is replaced.
    const res = await this.client.query<Row>(
      `UPDATE everdict_publication_operations
          SET state = 'claimed', claimed_by = $2, lease_until = $3::timestamptz + make_interval(secs => $4)
        WHERE id = $1
          AND state IN ('pending', 'claimed')
          AND (state = 'pending' OR lease_until IS NULL OR lease_until <= $3::timestamptz)
        RETURNING *`,
      [id, owner, now, leaseSeconds],
    );
    const row = res.rows[0];
    return row ? toOperation(row) : undefined;
  }

  async complete(id: string, owner: string, now: string): Promise<boolean> {
    // Conditional on STILL holding the claim: a publisher whose lease expired and whose work the sweep redid
    // must not overwrite the sweep's receipt.
    const res = await this.client.query<{ id: string }>(
      `UPDATE everdict_publication_operations
          SET state = 'published', published_at = $3::timestamptz, last_error = NULL
        WHERE id = $1 AND claimed_by = $2 AND state = 'claimed'
        RETURNING id`,
      [id, owner, now],
    );
    return res.rows.length > 0;
  }

  async release(id: string, owner: string, error: string, owed: boolean, now: string): Promise<void> {
    await this.client.query(
      `UPDATE everdict_publication_operations
          SET state = $4,
              last_error = $3,
              claimed_by = NULL,
              lease_until = NULL,
              published_at = CASE WHEN $4 = 'unverifiable' THEN $5::timestamptz ELSE published_at END
        WHERE id = $1 AND claimed_by = $2`,
      [id, owner, error, owed ? "pending" : "unverifiable", now],
    );
  }

  async listOwed(limit: number, now: string): Promise<PublicationOperation[]> {
    const res = await this.client.query<Row>(
      `SELECT * FROM everdict_publication_operations
        WHERE state = 'pending'
           OR (state = 'claimed' AND (lease_until IS NULL OR lease_until <= $2::timestamptz))
        ORDER BY planned_at ASC
        LIMIT $1`,
      [limit, now],
    );
    return res.rows.map(toOperation);
  }

  async listForScorecard(scorecardId: string): Promise<PublicationOperation[]> {
    const res = await this.client.query<Row>(
      `SELECT * FROM everdict_publication_operations
        WHERE scorecard_id = $1
        ORDER BY scoring_revision ASC`,
      [scorecardId],
    );
    return res.rows.map(toOperation);
  }
}
