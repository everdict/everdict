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

export const caseResultSchema = z
  .object({
    caseId: z.string(),
    harness: z.string().optional(),
    scores: z.array(caseScoreSchema).default([]),
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

export const scorecardRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }),
  status: scorecardStatusSchema,
  summary: z.array(metricSummarySchema).optional(),
  scorecard: fullScorecardSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
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
