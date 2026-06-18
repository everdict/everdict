import type { SqlClient } from "./client.js";
import { type ScorecardRecord, ScorecardRecordSchema, type ScorecardStore } from "./scorecard-store.js";

interface ScorecardRow {
  id: string;
  tenant: string;
  dataset_id: string;
  dataset_version: string;
  harness_id: string;
  harness_version: string;
  status: string;
  summary: unknown;
  scorecard: unknown;
  error: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

// row → ScorecardRecord. jsonb 는 pg 가 이미 파싱; timestamptz 는 Date → ISO. 계약은 Zod 로 한 번 검증.
// hasScorecard=false(목록)면 무거운 scorecard 는 생략한다.
function rowToRecord(row: ScorecardRow, hasScorecard: boolean): ScorecardRecord {
  return ScorecardRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    dataset: { id: row.dataset_id, version: row.dataset_version },
    harness: { id: row.harness_id, version: row.harness_version },
    status: row.status,
    summary: row.summary ?? undefined,
    scorecard: hasScorecard ? (row.scorecard ?? undefined) : undefined,
    error: row.error ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

// Postgres 기반 스코어카드 스토어. 인메모리와 동일한 계약 — apps/api 는 둘을 교체만 한다.
export class PgScorecardStore implements ScorecardStore {
  constructor(private readonly client: SqlClient) {}

  async create(r: ScorecardRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO assay_scorecards
        (id, tenant, dataset_id, dataset_version, harness_id, harness_version, status, summary, scorecard, error, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        r.id,
        r.tenant,
        r.dataset.id,
        r.dataset.version,
        r.harness.id,
        r.harness.version,
        r.status,
        r.summary ? JSON.stringify(r.summary) : null,
        r.scorecard ? JSON.stringify(r.scorecard) : null,
        r.error ? JSON.stringify(r.error) : null,
        r.createdAt,
        r.updatedAt,
      ],
    );
  }

  async update(id: string, patch: Partial<ScorecardRecord>): Promise<ScorecardRecord | undefined> {
    // 수명 필드만 갱신 허용(status/summary/scorecard/error/updatedAt).
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
    if (patch.scorecard !== undefined) {
      sets.push(`scorecard = $${i++}`);
      vals.push(JSON.stringify(patch.scorecard));
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
    const res = await this.client.query<ScorecardRow>(
      `UPDATE assay_scorecards SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    return res.rows[0] ? rowToRecord(res.rows[0], true) : undefined;
  }

  async get(id: string): Promise<ScorecardRecord | undefined> {
    const res = await this.client.query<ScorecardRow>("SELECT * FROM assay_scorecards WHERE id = $1", [id]);
    return res.rows[0] ? rowToRecord(res.rows[0], true) : undefined;
  }

  async list(tenant?: string): Promise<ScorecardRecord[]> {
    // 무거운 scorecard 컬럼은 SELECT 하지 않는다(목록 경량화).
    const res = await this.client.query<ScorecardRow>(
      `SELECT id, tenant, dataset_id, dataset_version, harness_id, harness_version, status, summary, error, created_at, updated_at
       FROM assay_scorecards
       WHERE ($1::text IS NULL OR tenant = $1)
       ORDER BY created_at DESC, id DESC`,
      [tenant ?? null],
    );
    return res.rows.map((row) => rowToRecord(row, false));
  }
}
