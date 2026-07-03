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

// 이 run 이 실제로 쓴 모델(리더보드 model 축, @assay/suite scorecardModels 결과와 동형 — 형태만 미러).
// observed = 트레이스 관측 · declared = spec 선언 · primary = 그룹 키(관측 우선, 없으면 선언). 경량이라 list 에도 포함.
export const ScorecardModelsSchema = z.object({
  observed: z.array(z.string()).default([]),
  declared: z.string().optional(),
  primary: z.string().optional(),
});
export type ScorecardModels = z.infer<typeof ScorecardModelsSchema>;

// 이 스코어카드 run 의 트리거 출처(provenance) — 어디서 발사됐나(schedule|github-actions|api|web…) + 커밋 좌표.
// GitHub Actions PR 발사는 제출 시점 임시 핀(pinOverrides: 슬롯→이미지)을 여기 기록한다 — 레지스트리는 무변경이므로
// "무엇으로 평가했나"의 재현 근거가 이 필드다. 경량 → 목록(list)에도 포함. Pg 는 origin jsonb(mig 0033, additive).
export const ScorecardOriginSchema = z.object({
  source: z.string(), // schedule|github-actions|api|web…
  repo: z.string().optional(), // "owner/name"
  sha: z.string().optional(),
  ref: z.string().optional(), // refs/heads/… | refs/pull/…
  prNumber: z.number().int().optional(),
  runUrl: z.string().optional(), // CI run 링크
  pinOverrides: z.record(z.string()).optional(), // 제출 시점 임시 핀(슬롯→이미지) — PR 이미지 스왑 기록
});
export type ScorecardOrigin = z.infer<typeof ScorecardOriginSchema>;

// 실행 과정 스텝(타임라인) — "진행 과정"을 보이기 위해 run 이 진행되며 append 된다(증분 저장).
// phase = dispatch|judges|metrics|offload|persist|case, status = started|ok|failed|info.
// Pg 는 steps jsonb 컬럼(mig 0026, additive). 무거운 detail 이라 목록(list)에선 생략하고 get 에서만 돌려준다.
export const ScorecardStepSchema = z.object({
  ts: z.string(),
  phase: z.string(),
  status: z.enum(["started", "ok", "failed", "info"]),
  message: z.string(),
  caseId: z.string().optional(),
});
export type ScorecardStep = z.infer<typeof ScorecardStepSchema>;

export const ScorecardRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }), // 해석된 구체 버전(never "latest")
  status: ScorecardStatusSchema,
  summary: z.array(MetricSummarySchema).optional(), // 경량 집계(목록용)
  models: ScorecardModelsSchema.optional(), // 이 run 이 쓴 모델(리더보드 축, 경량 → 목록에도 포함). 과거 레코드는 미설정.
  // 이 run 을 채점한 judge 모델(들) — model 축이 '하니스가 쓴 LLM'이라면 이건 '채점자'. 공정 비교(같은 judge)용
  // 필터/표시. inline judge config.model + 등록 model-judge spec.model 의 distinct. 경량 → 목록에도 포함.
  judgeModels: z.array(z.string()).optional(),
  origin: ScorecardOriginSchema.optional(), // 트리거 출처(provenance) — 경량이라 목록에도 포함. 과거 레코드는 미설정.
  scorecard: ScorecardSchema.optional(), // 케이스별 전체 결과(상세용, 무거움)
  error: ScorecardRunErrorSchema.optional(),
  steps: z.array(ScorecardStepSchema).optional(), // 실행 과정 타임라인(진행 중에도 append)
  // 이 배치가 팬아웃한 자식 run 들의 id(있으면). scorecard = run × N 을 참조로 표현 — 케이스별 addressable run 드릴다운.
  // 무거운 scorecard(임베드 결과)와 별개의 경량 참조. get 에서만(steps 처럼) — 상세용. 과거 레코드/ingest 경로는 미설정.
  runIds: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScorecardRecord = z.infer<typeof ScorecardRecordSchema>;

// list 필터 — dataset/harness/status 를 스토어(SQL)에서 좁힌다(리더보드/트렌드가 전 워크스페이스를 훑지 않게).
// 미지정이면 전체(현행). model/judgeModel 등 요약-파생 축은 서비스/suite 에서 계속 필터(SQL 로 못 좁힘).
export interface ScorecardListFilter {
  dataset?: string; // dataset.id
  harness?: string; // harness.id
  status?: ScorecardStatus;
}

// 스코어카드 스토어 계약. in-memory(개발/테스트) 또는 Postgres(운영) — 같은 인터페이스 뒤로 교체.
// 주의: list 는 무거운 `scorecard`(트레이스 포함) 필드를 의도적으로 생략한다(summary 만). 전체는 get 으로.
export interface ScorecardStore {
  create(record: ScorecardRecord): Promise<void>;
  update(id: string, patch: Partial<ScorecardRecord>): Promise<ScorecardRecord | undefined>;
  get(id: string): Promise<ScorecardRecord | undefined>;
  list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]>;
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

  async list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]> {
    const all = [...this.cards.values()]
      .filter((c) => !tenant || c.tenant === tenant)
      .filter((c) => !filter?.dataset || c.dataset.id === filter.dataset)
      .filter((c) => !filter?.harness || c.harness.id === filter.harness)
      .filter((c) => !filter?.status || c.status === filter.status);
    // 목록은 무거운 scorecard/steps + 상세용 runIds 생략(summary/models 만) — 상세는 get 으로.
    return all.map(({ scorecard, steps, runIds, ...rest }) => rest);
  }
}
