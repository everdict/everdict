import type { ScorecardListFilter, ScorecardStore } from "@everdict/application-control";
import { type ScorecardRecord, ScorecardRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

interface ScorecardRow {
  id: string;
  tenant: string;
  dataset_id: string;
  dataset_version: string;
  harness_id: string;
  harness_version: string;
  status: string;
  summary: unknown;
  orchestration: unknown; // resume/retry inputs (mig 0049)
  models: unknown;
  judge_models: unknown;
  origin: unknown;
  created_by: string | null;
  runtime: string | null;
  subset: unknown;
  scorecard: unknown;
  sink_export: unknown;
  error: unknown;
  steps: unknown;
  run_ids: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

// row → ScorecardRecord. jsonb is already parsed by pg; timestamptz is Date → ISO. The contract is validated once with Zod.
// If hasDetail=false (list), the heavy scorecard/steps are omitted.
function rowToRecord(row: ScorecardRow, hasDetail: boolean): ScorecardRecord {
  return ScorecardRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    dataset: { id: row.dataset_id, version: row.dataset_version },
    harness: { id: row.harness_id, version: row.harness_version },
    status: row.status,
    summary: row.summary ?? undefined,
    models: row.models ?? undefined, // lightweight → included in list too
    judgeModels: row.judge_models ?? undefined, // lightweight → included in list too (judge-axis filter/display)
    origin: row.origin ?? undefined, // lightweight → included in list too (trigger-provenance chip/commit link)
    createdBy: row.created_by ?? undefined, // lightweight → included in list too (runner display/filter)
    runtime: row.runtime ?? undefined, // lightweight → included in list too (work-queue runtime axis)
    subset: row.subset ?? undefined, // lightweight → included in list too (partial-run badge)
    orchestration: row.orchestration ?? undefined, // resume/retry inputs (mig 0049) — lightweight
    scorecard: hasDetail ? (row.scorecard ?? undefined) : undefined,
    export: hasDetail ? (row.sink_export ?? undefined) : undefined, // for detail (get only, like steps). Column name is sink_export (reserved-word avoidance)
    error: row.error ?? undefined,
    steps: hasDetail ? (row.steps ?? undefined) : undefined,
    runIds: hasDetail ? (row.run_ids ?? undefined) : undefined, // detail-only lightweight reference (get only, like steps)
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

// Postgres-backed scorecard store. Same contract as in-memory — apps/api just swaps the two.
export class PgScorecardStore implements ScorecardStore {
  constructor(private readonly client: SqlClient) {}

  async create(r: ScorecardRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_scorecards
        (id, tenant, dataset_id, dataset_version, harness_id, harness_version, status, summary, models, judge_models, origin, created_by, runtime, subset, orchestration, scorecard, sink_export, error, steps, run_ids, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        r.id,
        r.tenant,
        r.dataset.id,
        r.dataset.version,
        r.harness.id,
        r.harness.version,
        r.status,
        r.summary ? JSON.stringify(r.summary) : null,
        r.models ? JSON.stringify(r.models) : null,
        r.judgeModels ? JSON.stringify(r.judgeModels) : null,
        r.origin ? JSON.stringify(r.origin) : null,
        r.createdBy ?? null,
        r.runtime ?? null,
        r.subset ? JSON.stringify(r.subset) : null,
        r.orchestration ? JSON.stringify(r.orchestration) : null,
        r.scorecard ? JSON.stringify(r.scorecard) : null,
        r.export ? JSON.stringify(r.export) : null,
        r.error ? JSON.stringify(r.error) : null,
        r.steps ? JSON.stringify(r.steps) : null,
        r.runIds ? JSON.stringify(r.runIds) : null,
        r.createdAt,
        r.updatedAt,
      ],
    );
  }

  async update(id: string, patch: Partial<ScorecardRecord>): Promise<ScorecardRecord | undefined> {
    // Only lifecycle fields are allowed to be updated (status/summary/scorecard/error/steps/updatedAt).
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      vals.push(patch.status);
    }
    if (patch.summary !== undefined) {
      sets.push(`summary = $${i++}`);
      vals.push(JSON.stringify(patch.summary));
    }
    if (patch.orchestration !== undefined) {
      // submit stamps workflowId onto the persisted orchestration (batch-on-Temporal) — silently dropping this
      // left records unmarked and boot recovery double-driving workflow-owned batches.
      sets.push(`orchestration = $${i++}`);
      vals.push(JSON.stringify(patch.orchestration));
    }
    if (patch.models !== undefined) {
      sets.push(`models = $${i++}`);
      vals.push(JSON.stringify(patch.models));
    }
    if (patch.judgeModels !== undefined) {
      sets.push(`judge_models = $${i++}`);
      vals.push(JSON.stringify(patch.judgeModels));
    }
    if (patch.origin !== undefined) {
      sets.push(`origin = $${i++}`);
      vals.push(JSON.stringify(patch.origin));
    }
    if (patch.scorecard !== undefined) {
      sets.push(`scorecard = $${i++}`);
      vals.push(JSON.stringify(patch.scorecard));
    }
    if (patch.export !== undefined) {
      sets.push(`sink_export = $${i++}`);
      vals.push(JSON.stringify(patch.export));
    }
    if (patch.error !== undefined) {
      sets.push(`error = $${i++}`);
      vals.push(JSON.stringify(patch.error));
    }
    if (patch.steps !== undefined) {
      sets.push(`steps = $${i++}`);
      vals.push(JSON.stringify(patch.steps));
    }
    if (patch.runIds !== undefined) {
      sets.push(`run_ids = $${i++}`);
      vals.push(JSON.stringify(patch.runIds));
    }
    if (patch.updatedAt !== undefined) {
      sets.push(`updated_at = $${i++}`);
      vals.push(patch.updatedAt);
    }
    if (sets.length === 0) return this.get(id);
    vals.push(id);
    const res = await this.client.query<ScorecardRow>(
      `UPDATE everdict_scorecards SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    return res.rows[0] ? rowToRecord(res.rows[0], true) : undefined;
  }

  async get(id: string): Promise<ScorecardRecord | undefined> {
    const res = await this.client.query<ScorecardRow>("SELECT * FROM everdict_scorecards WHERE id = $1", [id]);
    return res.rows[0] ? rowToRecord(res.rows[0], true) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.client.query<{ id: string }>("DELETE FROM everdict_scorecards WHERE id = $1 RETURNING id", [
      id,
    ]);
    return res.rows.length > 0;
  }

  async list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]> {
    // Don't SELECT the heavy scorecard column (lighter list). Filters narrow via the SQL WHERE (leaderboard/trend).
    const conds = ["($1::text IS NULL OR tenant = $1)"];
    const vals: unknown[] = [tenant ?? null];
    let i = 2;
    if (filter?.dataset) {
      conds.push(`dataset_id = $${i++}`);
      vals.push(filter.dataset);
    }
    if (filter?.harness) {
      conds.push(`harness_id = $${i++}`);
      vals.push(filter.harness);
    }
    if (filter?.status) {
      conds.push(`status = $${i++}`);
      vals.push(filter.status);
    }
    if (filter?.judge) {
      // jsonb containment on the persisted orchestration.judges — matches the judge id at any version.
      conds.push(`orchestration->'judges' @> $${i++}::jsonb`);
      vals.push(JSON.stringify([{ id: filter.judge }]));
    }
    const res = await this.client.query<ScorecardRow>(
      `SELECT id, tenant, dataset_id, dataset_version, harness_id, harness_version, status, summary, models, judge_models, origin, created_by, runtime, subset, error, created_at, updated_at
       FROM everdict_scorecards
       WHERE ${conds.join(" AND ")}
       ORDER BY created_at DESC, id DESC`,
      vals,
    );
    return res.rows.map((row) => rowToRecord(row, false));
  }
}
