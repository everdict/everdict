import { z } from 'zod'

// 컨트롤플레인 ScorecardRecord 의 클라이언트 미러. 웹은 HTTP 로만 결합 — 백엔드 패키지 비의존.
export const scorecardStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed'])
export type ScorecardStatus = z.infer<typeof scorecardStatusSchema>

// 메트릭별 집계(목록/상세 공통).
export const metricSummarySchema = z.object({
  metric: z.string(),
  count: z.number(),
  mean: z.number(),
  passRate: z.number().optional(),
})
export type MetricSummary = z.infer<typeof metricSummarySchema>

// 케이스별 점수(느슨 — 표시 필드만, 나머지 passthrough). detail = grader/judge 의 판정 사유(VLM 루브릭 reasoning 등).
export const caseScoreSchema = z
  .object({
    graderId: z.string(),
    metric: z.string(),
    value: z.number(),
    pass: z.boolean().optional(),
    detail: z.string().optional(),
  })
  .passthrough()

// 트레이스 이벤트(느슨) — 표시는 error 이벤트(케이스 실패 사유)만 본다. 나머지는 passthrough.
export const traceEventSchema = z
  .object({ kind: z.string(), message: z.string().optional() })
  .passthrough()

export const caseResultSchema = z
  .object({
    caseId: z.string(),
    harness: z.string().optional(),
    scores: z.array(caseScoreSchema).default([]),
    trace: z.array(traceEventSchema).default([]), // 케이스 실행 트레이스 — error 이벤트로 실패 구간 노출

    // os-use=데스크탑 스냅샷(screenshot/screenshotRef → <img>). browser=서비스-토폴로지 스냅샷(url=최종 URL, dom=발췌).
    snapshot: z
      .object({
        kind: z.string(),
        screenshot: z.string().optional(),
        screenshotRef: z.string().optional(),
        url: z.string().optional(),
        dom: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

// GET /scorecards/:id 의 전체 scorecard(케이스별 결과 포함).
export const fullScorecardSchema = z
  .object({
    suiteId: z.string(),
    harness: z.string(),
    results: z.array(caseResultSchema).default([]),
  })
  .passthrough()

// 실행 과정 스텝(타임라인) — run 이 진행되며 append. 웹은 이 순서대로 "진행 과정"을 보여준다.
export const scorecardStepSchema = z.object({
  ts: z.string(),
  phase: z.string(), // dispatch | judges | metrics | offload | persist | case
  status: z.enum(['started', 'ok', 'failed', 'info']),
  message: z.string(),
  caseId: z.string().optional(),
})
export type ScorecardStep = z.infer<typeof scorecardStepSchema>

// 이 run 이 실제로 쓴 모델(리더보드 model 축). observed=트레이스 관측, declared=spec 선언, primary=대표(관측 우선).
export const scorecardModelsSchema = z.object({
  observed: z.array(z.string()).default([]),
  declared: z.string().optional(),
  primary: z.string().optional(),
})
export type ScorecardModels = z.infer<typeof scorecardModelsSchema>

export const scorecardRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }),
  status: scorecardStatusSchema,
  summary: z.array(metricSummarySchema).optional(),
  models: scorecardModelsSchema.optional(), // 과거 레코드는 미설정(unknown)
  judgeModels: z.array(z.string()).optional(), // 이 run 을 채점한 judge 모델(들) — model 축과 별개(채점자)
  scorecard: fullScorecardSchema.optional(),
  error: z
    .object({ code: z.string(), message: z.string(), phase: z.string().optional() })
    .optional(),
  steps: z.array(scorecardStepSchema).default([]), // 진행 과정 타임라인(진행 중에도 갱신)
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ScorecardRecord = z.infer<typeof scorecardRecordSchema>
export const scorecardsSchema = z.array(scorecardRecordSchema)

// GET /scorecards/diff 응답: baseline vs candidate (메트릭 mean delta + 케이스 회귀/개선).
export const caseDeltaSchema = z.object({
  caseId: z.string(),
  metric: z.string(),
  baseline: z.number(),
  candidate: z.number(),
  delta: z.number(),
  passChange: z.enum(['fixed', 'broke']).optional(),
})
export type CaseDelta = z.infer<typeof caseDeltaSchema>

export const scorecardDiffSchema = z.object({
  baseline: z.string(),
  candidate: z.string(),
  metrics: z.array(
    z.object({
      metric: z.string(),
      baselineMean: z.number(),
      candidateMean: z.number(),
      delta: z.number(),
    })
  ),
  regressions: z.array(caseDeltaSchema),
  improvements: z.array(caseDeltaSchema),
})
export type ScorecardDiff = z.infer<typeof scorecardDiffSchema>

// GET /scorecards/trend 응답: 한 (dataset, metric) 의 시간순 스코어카드 + baseline 대비 회귀.
export const trendPointSchema = z.object({
  scorecardId: z.string(),
  harness: z.string(),
  createdAt: z.string(),
  mean: z.number().nullable(),
  passRate: z.number().nullable(),
  score: z.number().nullable(),
  deltaVsBaseline: z.number().nullable(),
  regressed: z.boolean(),
})
export type TrendPoint = z.infer<typeof trendPointSchema>

export const scorecardTrendSchema = z.object({
  dataset: z.string(),
  metric: z.string(),
  baseline: z.string(),
  points: z.array(trendPointSchema),
})
export type ScorecardTrend = z.infer<typeof scorecardTrendSchema>

// GET /scorecards/leaderboard 응답: 한 데이터셋(벤치마크)의 (harness × model) 랭킹(metric 내림차순).
export const leaderboardRowSchema = z.object({
  rank: z.number(),
  harness: z.object({ id: z.string(), version: z.string() }),
  model: z.string().optional(),
  judgeModels: z.array(z.string()).optional(), // 대표 run 을 채점한 judge 모델(들)
  scorecardId: z.string(),
  createdAt: z.string(),
  score: z.number().nullable(),
  passRate: z.number().nullable(),
  mean: z.number().nullable(),
  runs: z.number(),
})
export type LeaderboardRow = z.infer<typeof leaderboardRowSchema>

export const leaderboardSchema = z.object({
  dataset: z.string(),
  metric: z.string(),
  window: z.enum(['latest', 'best']),
  rows: z.array(leaderboardRowSchema),
})
export type Leaderboard = z.infer<typeof leaderboardSchema>
