import type { OutboxEvent, RunListOptions, RunStore } from "@everdict/application-control";
import { type RunRecord, RunRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { withRunUsage } from "./run-store.js";

interface RunRow {
  id: string;
  tenant: string;
  harness_id: string;
  harness_version: string;
  case_id: string;
  status: string;
  result: unknown;
  error: unknown;
  parent_scorecard_id: string | null;
  trigger: string | null;
  created_by: string | null;
  runtime: string | null;
  case_spec: unknown | null;
  // The universal-run shape (mig 0092) — nullable; absent = legacy eval run.
  kind: string | null;
  class: string | null;
  lifetime: string | null;
  origin: unknown | null;
  envelope: unknown | null;
  placement: unknown | null;
  attach: unknown | null;
  group_ref: unknown | null;
  lineage: unknown | null;
  outputs: unknown | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

// row → RunRecord (jsonb is already parsed by pg; timestamptz is Date → ISO). The contract is validated once with Zod.
function rowToRecord(row: RunRow): RunRecord {
  const rec = RunRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    harness: { id: row.harness_id, version: row.harness_version },
    caseId: row.case_id,
    status: row.status,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    parentScorecardId: row.parent_scorecard_id ?? undefined,
    trigger: row.trigger ?? undefined,
    createdBy: row.created_by ?? undefined,
    runtime: row.runtime ?? undefined,
    ...(row.case_spec ? { caseSpec: row.case_spec } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.class ? { class: row.class } : {}),
    ...(row.lifetime ? { lifetime: row.lifetime } : {}),
    ...(row.origin ? { origin: row.origin } : {}),
    ...(row.envelope ? { envelope: row.envelope } : {}),
    ...(row.placement ? { placement: row.placement } : {}),
    ...(row.attach ? { attach: row.attach } : {}),
    ...(row.group_ref ? { group: row.group_ref } : {}),
    ...(row.lineage ? { lineage: row.lineage } : {}),
    ...(row.outputs ? { outputs: row.outputs } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
  return withRunUsage(rec); // usage is not a column, it's derived from result.trace
}

// E0 same-tx outbox: append the event rows in the SAME STATEMENT as the run write via a data-modifying CTE —
// atomicity without a transaction seam on SqlClient (parameterized multi-statement is not a thing in pg's
// extended protocol; one statement with two writes is). seq stays BIGSERIAL — the log's cursor is untouched.
function eventValuesClause(events: OutboxEvent[], startIndex: number): { sql: string; params: unknown[] } {
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

const EVENT_COLUMNS = "(id, tenant, kind, subject_type, subject_id, actor, payload, caused_by, message, created_at)";

const RUN_COLUMNS =
  "(id, tenant, harness_id, harness_version, case_id, status, result, error, parent_scorecard_id, trigger, created_by, runtime, case_spec, kind, class, lifetime, origin, envelope, placement, attach, group_ref, lineage, outputs, created_at, updated_at)";
const RUN_VALUES = "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)";

function runInsertParams(r: RunRecord): unknown[] {
  return [
    r.id,
    r.tenant,
    r.harness.id,
    r.harness.version,
    r.caseId,
    r.status,
    r.result ? JSON.stringify(r.result) : null,
    r.error ? JSON.stringify(r.error) : null,
    r.parentScorecardId ?? null,
    r.trigger ?? null,
    r.createdBy ?? null,
    r.runtime ?? null,
    r.caseSpec ? JSON.stringify(r.caseSpec) : null,
    r.kind ?? null,
    r.class ?? null,
    r.lifetime ?? null,
    r.origin ? JSON.stringify(r.origin) : null,
    r.envelope ? JSON.stringify(r.envelope) : null,
    r.placement ? JSON.stringify(r.placement) : null,
    r.attach ? JSON.stringify(r.attach) : null,
    r.group ? JSON.stringify(r.group) : null,
    r.lineage ? JSON.stringify(r.lineage) : null,
    r.outputs ? JSON.stringify(r.outputs) : null,
    r.createdAt,
    r.updatedAt,
  ];
}

// Postgres-backed result store. Same RunStore contract as in-memory — apps/api just swaps the two.
export class PgRunStore implements RunStore {
  constructor(private readonly client: SqlClient) {}

  async create(r: RunRecord, events?: OutboxEvent[]): Promise<void> {
    const base = runInsertParams(r);
    if (events && events.length > 0) {
      // One statement, two writes (E0): the run insert and its facts commit or roll back together.
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_runs ${RUN_COLUMNS} VALUES ${RUN_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_runs ${RUN_COLUMNS} VALUES ${RUN_VALUES}`, base);
  }

  async update(id: string, patch: Partial<RunRecord>, events?: OutboxEvent[]): Promise<RunRecord | undefined> {
    // Only lifecycle fields are allowed to be updated (status/result/error/runtime/updatedAt).
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      vals.push(patch.status);
    }
    if (patch.result !== undefined) {
      sets.push(`result = $${i++}`);
      vals.push(JSON.stringify(patch.result));
    }
    if (patch.error !== undefined) {
      sets.push(`error = $${i++}`);
      vals.push(JSON.stringify(patch.error));
    }
    // Spillover provenance — settle rewrites the assigned runtime to the one that actually ran the case.
    if (patch.runtime !== undefined) {
      sets.push(`runtime = $${i++}`);
      vals.push(patch.runtime);
    }
    if (patch.outputs !== undefined) {
      sets.push(`outputs = $${i++}`);
      vals.push(JSON.stringify(patch.outputs));
    }
    if (patch.lineage !== undefined) {
      sets.push(`lineage = $${i++}`);
      vals.push(JSON.stringify(patch.lineage));
    }
    if (patch.updatedAt !== undefined) {
      sets.push(`updated_at = $${i++}`);
      vals.push(patch.updatedAt);
    }
    if (sets.length === 0) return this.get(id);
    vals.push(id);
    if (events && events.length > 0) {
      // One statement, two writes (E0): the terminal patch and the facts describing it commit atomically —
      // and the facts land ONLY if the update matched a row (WHERE EXISTS on the updating CTE).
      const ev = eventValuesClause(events, vals.length + 1);
      const res = await this.client.query<RunRow>(
        `WITH upd AS (UPDATE everdict_runs SET ${sets.join(", ")} WHERE id = $${i} RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...vals, ...ev.params],
      );
      return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
    }
    const res = await this.client.query<RunRow>(
      `UPDATE everdict_runs SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async get(id: string): Promise<RunRecord | undefined> {
    const res = await this.client.query<RunRow>("SELECT * FROM everdict_runs WHERE id = $1", [id]);
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]> {
    // scorecardId given → that batch's children only; else includeChildren ($3) → all runs (standalone + children);
    // otherwise standalone (parentless) runs only (children hidden → prevents activity-list flooding).
    // runnerId ($4) → runs this self-hosted runner executed (jsonb result.provenance.runner); implies children
    // included. limit ($5, NULL = all) caps the activity feed. LIMIT NULL is valid Postgres (unlimited). offset ($6,
    // default 0) skips the first N rows for the runner-detail activity feed's offset pagination.
    const res = await this.client.query<RunRow>(
      `SELECT * FROM everdict_runs
       WHERE ($1::text IS NULL OR tenant = $1)
         AND ($4::text IS NULL OR result->'provenance'->>'runner' = $4)
         AND (
           ($2::text IS NOT NULL AND parent_scorecard_id = $2)
           OR ($2::text IS NULL AND ($3::bool OR $4::text IS NOT NULL OR parent_scorecard_id IS NULL))
         )
       ORDER BY created_at DESC, id DESC
       LIMIT $5 OFFSET $6`,
      [
        tenant ?? null,
        opts?.scorecardId ?? null,
        opts?.includeChildren ?? false,
        opts?.runnerId ?? null,
        opts?.limit ?? null,
        opts?.offset ?? 0,
      ],
    );
    return res.rows.map(rowToRecord);
  }

  async deleteByScorecard(scorecardId: string): Promise<number> {
    const res = await this.client.query<{ id: string }>(
      "DELETE FROM everdict_runs WHERE parent_scorecard_id = $1 RETURNING id",
      [scorecardId],
    );
    return res.rows.length;
  }
}
