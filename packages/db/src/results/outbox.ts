import type { OutboxEvent } from "@everdict/application-control";

// E0 same-tx outbox — shared by every Pg result store that persists aggregate facts (PgRunStore,
// PgScorecardStore): append the event rows in the SAME STATEMENT as the aggregate write via a
// data-modifying CTE — atomicity without a transaction seam on SqlClient (parameterized multi-statement
// is not a thing in pg's extended protocol; one statement with two writes is). seq stays BIGSERIAL —
// the log's cursor is untouched.
export const EVENT_COLUMNS =
  "(id, tenant, kind, subject_type, subject_id, actor, payload, caused_by, message, created_at)";

export function eventValuesClause(events: OutboxEvent[], startIndex: number): { sql: string; params: unknown[] } {
  const tuples: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;
  for (const e of events) {
    tuples.push(
      `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}::jsonb, $${i++}, $${i++}, $${i++}::timestamptz)`,
    );
    params.push(
      e.id,
      e.tenant,
      e.kind,
      e.subject.type,
      e.subject.id,
      e.actor ?? null,
      JSON.stringify(e.payload ?? {}),
      e.causedBy ?? null,
      e.message,
      e.createdAt,
    );
  }
  return { sql: tuples.join(","), params };
}
