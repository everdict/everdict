import type { SqlClient } from "./client.js";
import { type RunListOptions, type RunRecord, RunRecordSchema, type RunStore, withRunUsage } from "./run-store.js";

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
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
  return withRunUsage(rec); // usage is not a column, it's derived from result.trace
}

// Postgres-backed result store. Same RunStore contract as in-memory — apps/api just swaps the two.
export class PgRunStore implements RunStore {
  constructor(private readonly client: SqlClient) {}

  async create(r: RunRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_runs
        (id, tenant, harness_id, harness_version, case_id, status, result, error, parent_scorecard_id, trigger, created_by, runtime, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
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
        r.createdAt,
        r.updatedAt,
      ],
    );
  }

  async update(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined> {
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
    if (patch.updatedAt !== undefined) {
      sets.push(`updated_at = $${i++}`);
      vals.push(patch.updatedAt);
    }
    if (sets.length === 0) return this.get(id);
    vals.push(id);
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
    // scorecardId given → that batch's children only; otherwise standalone (parentless) runs only (children hidden → prevents activity-list flooding).
    const res = await this.client.query<RunRow>(
      `SELECT * FROM everdict_runs
       WHERE ($1::text IS NULL OR tenant = $1)
         AND (($2::text IS NULL AND parent_scorecard_id IS NULL) OR parent_scorecard_id = $2)
       ORDER BY created_at DESC, id DESC`,
      [tenant ?? null, opts?.scorecardId ?? null],
    );
    return res.rows.map(rowToRecord);
  }
}
