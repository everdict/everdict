import { ScorecardSchema } from "@assay/core";
import { z } from "zod";

// 스코어카드 run 의 수명: 데이터셋×하니스 배치 평가 접수 → 실행 → 성공/실패. 스토어가 이 레코드를 보관한다.
export const ScorecardStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
export type ScorecardStatus = z.infer<typeof ScorecardStatusSchema>;

// phase = 실패한 파이프라인 구간(dispatch|judges|metrics|offload|persist) — "어떤 구간에서" 진단용(jsonb 라 마이그레이션 불요).
export const ScorecardRunErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  phase: z.string().optional(),
});

// 메트릭별 집계(@assay/suite summarizeScorecard 결과와 동형). db 는 core 만 의존 → 여기서 형태만 미러.
export const MetricSummarySchema = z.object({
  metric: z.string(),
  count: z.number(),
  mean: z.number(),
  passRate: z.number().optional(),
});
export type MetricSummary = z.infer<typeof MetricSummarySchema>;

export const ScorecardRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }), // 해석된 구체 버전(never "latest")
  status: ScorecardStatusSchema,
  summary: z.array(MetricSummarySchema).optional(), // 경량 집계(목록용)
  scorecard: ScorecardSchema.optional(), // 케이스별 전체 결과(상세용, 무거움)
  error: ScorecardRunErrorSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScorecardRecord = z.infer<typeof ScorecardRecordSchema>;

// 스코어카드 스토어 계약. in-memory(개발/테스트) 또는 Postgres(운영) — 같은 인터페이스 뒤로 교체.
// 주의: list 는 무거운 `scorecard`(트레이스 포함) 필드를 의도적으로 생략한다(summary 만). 전체는 get 으로.
export interface ScorecardStore {
  create(record: ScorecardRecord): Promise<void>;
  update(id: string, patch: Partial<ScorecardRecord>): Promise<ScorecardRecord | undefined>;
  get(id: string): Promise<ScorecardRecord | undefined>;
  list(tenant?: string): Promise<ScorecardRecord[]>;
}

export class InMemoryScorecardStore implements ScorecardStore {
  private readonly cards = new Map<string, ScorecardRecord>();

  async create(record: ScorecardRecord): Promise<void> {
    this.cards.set(record.id, record);
  }

  async update(id: string, patch: Partial<ScorecardRecord>): Promise<ScorecardRecord | undefined> {
    const cur = this.cards.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.cards.set(id, next);
    return next;
  }

  async get(id: string): Promise<ScorecardRecord | undefined> {
    return this.cards.get(id);
  }

  async list(tenant?: string): Promise<ScorecardRecord[]> {
    const all = [...this.cards.values()].filter((c) => !tenant || c.tenant === tenant);
    // 목록은 무거운 scorecard 생략(summary 만) — 상세는 get 으로.
    return all.map(({ scorecard, ...rest }) => rest);
  }
}
