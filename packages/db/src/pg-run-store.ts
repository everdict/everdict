import type { SqlClient } from "./client.js";
import { type RunRecord, RunRecordSchema, type RunStore, withRunUsage } from "./run-store.js";

interface RunRow {
  id: string;
  tenant: string;
  harness_id: string;
  harness_version: string;
  case_id: string;
  status: string;
  result: unknown;
  error: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

// row → RunRecord (jsonb 는 pg 가 이미 파싱; timestamptz 는 Date → ISO). 계약은 Zod 로 한 번 검증.
function rowToRecord(row: RunRow): RunRecord {
  const rec = RunRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    harness: { id: row.harness_id, version: row.harness_version },
    caseId: row.case_id,
    status: row.status,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
  return withRunUsage(rec); // usage 는 컬럼이 아니라 result.trace 에서 파생
}

// Postgres 기반 결과 스토어. 인메모리와 동일한 RunStore 계약 — apps/api 는 둘을 교체만 한다.
export class PgRunStore implements RunStore {
  constructor(private readonly client: SqlClient) {}

  async create(r: RunRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO assay_runs
        (id, tenant, harness_id, harness_version, case_id, status, result, error, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        r.id,
        r.tenant,
        r.harness.id,
        r.harness.version,
        r.caseId,
        r.status,
        r.result ? JSON.stringify(r.result) : null,
        r.error ? JSON.stringify(r.error) : null,
        r.createdAt,
        r.updatedAt,
      ],
    );
  }

  async update(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined> {
    // 수명 필드만 갱신 허용(status/result/error/updatedAt).
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
    if (patch.updatedAt !== undefined) {
      sets.push(`updated_at = $${i++}`);
      vals.push(patch.updatedAt);
    }
    if (sets.length === 0) return this.get(id);
    vals.push(id);
    const res = await this.client.query<RunRow>(
      `UPDATE assay_runs SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async get(id: string): Promise<RunRecord | undefined> {
    const res = await this.client.query<RunRow>("SELECT * FROM assay_runs WHERE id = $1", [id]);
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async list(tenant?: string): Promise<RunRecord[]> {
    const res = await this.client.query<RunRow>(
      `SELECT * FROM assay_runs
       WHERE ($1::text IS NULL OR tenant = $1)
       ORDER BY created_at DESC, id DESC`,
      [tenant ?? null],
    );
    return res.rows.map(rowToRecord);
  }
}
