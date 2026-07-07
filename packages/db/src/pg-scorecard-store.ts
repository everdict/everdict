import type { SqlClient } from "./client.js";
import {
  type ScorecardListFilter,
  type ScorecardRecord,
  ScorecardRecordSchema,
  type ScorecardStore,
} from "./scorecard-store.js";

interface ScorecardRow {
  id: string;
  tenant: string;
  dataset_id: string;
  dataset_version: string;
  harness_id: string;
  harness_version: string;
  status: string;
  summary: unknown;
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

// row → ScorecardRecord. jsonb 는 pg 가 이미 파싱; timestamptz 는 Date → ISO. 계약은 Zod 로 한 번 검증.
// hasDetail=false(목록)면 무거운 scorecard/steps 는 생략한다.
function rowToRecord(row: ScorecardRow, hasDetail: boolean): ScorecardRecord {
  return ScorecardRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    dataset: { id: row.dataset_id, version: row.dataset_version },
    harness: { id: row.harness_id, version: row.harness_version },
    status: row.status,
    summary: row.summary ?? undefined,
    models: row.models ?? undefined, // 경량 → 목록에도 포함
    judgeModels: row.judge_models ?? undefined, // 경량 → 목록에도 포함(judge 축 필터/표시)
    origin: row.origin ?? undefined, // 경량 → 목록에도 포함(트리거 출처 칩/커밋 링크)
    createdBy: row.created_by ?? undefined, // 경량 → 목록에도 포함(실행자 표기/필터)
    runtime: row.runtime ?? undefined, // 경량 → 목록에도 포함(작업 큐 런타임 축)
    subset: row.subset ?? undefined, // 경량 → 목록에도 포함(부분 실행 배지)
    scorecard: hasDetail ? (row.scorecard ?? undefined) : undefined,
    export: hasDetail ? (row.sink_export ?? undefined) : undefined, // 상세용(steps 처럼 get 에서만). 컬럼명은 sink_export(예약어 회피)
    error: row.error ?? undefined,
    steps: hasDetail ? (row.steps ?? undefined) : undefined,
    runIds: hasDetail ? (row.run_ids ?? undefined) : undefined, // 상세용 경량 참조(steps 처럼 get 에서만)
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

// Postgres 기반 스코어카드 스토어. 인메모리와 동일한 계약 — apps/api 는 둘을 교체만 한다.
export class PgScorecardStore implements ScorecardStore {
  constructor(private readonly client: SqlClient) {}

  async create(r: ScorecardRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_scorecards
        (id, tenant, dataset_id, dataset_version, harness_id, harness_version, status, summary, models, judge_models, origin, created_by, runtime, subset, scorecard, sink_export, error, steps, run_ids, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
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
    // 수명 필드만 갱신 허용(status/summary/scorecard/error/steps/updatedAt).
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

  async list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]> {
    // 무거운 scorecard 컬럼은 SELECT 하지 않는다(목록 경량화). 필터는 SQL WHERE 로 좁힌다(리더보드/트렌드).
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
