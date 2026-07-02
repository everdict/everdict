import { z } from 'zod'

// 컨트롤플레인 RunRecord 의 클라이언트 미러. 웹은 HTTP 로만 결합 — 백엔드 패키지 비의존.
export const scoreSchema = z.object({
  graderId: z.string(),
  metric: z.string(),
  value: z.number(),
  pass: z.boolean().optional(),
  detail: z.string().optional(),
})
export type Score = z.infer<typeof scoreSchema>

// 트레이스 이벤트는 kind 별 형태가 다양 → 느슨하게(passthrough) 파싱하고 UI 에서 분기.
export const traceEventSchema = z.object({ t: z.number(), kind: z.string() }).passthrough()
export type TraceEvent = z.infer<typeof traceEventSchema>

export const resultSchema = z
  .object({
    scores: z.array(scoreSchema).default([]),
    trace: z.array(traceEventSchema).default([]),
    // os-use=데스크탑 스냅샷(screenshot=base64 PNG dev 인라인 / screenshotRef=object storage URL 오프로드 → <img>).
    // browser=서비스-토폴로지(browser-use 등) 스냅샷: url=최종 방문 URL, dom=추출 텍스트/DOM 발췌.
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
    harness: z.string().optional(),
  })
  .partial()

// 사용량 요약 — 컨트롤플레인이 result.trace 에서 파생(usageFromTrace). 활동 리스트가 트레이스 파싱 없이 비용/토큰 표시.
export const usageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  usd: z.number(),
  calls: z.number(),
})
export type Usage = z.infer<typeof usageSchema>

export const runSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  result: resultSchema.optional(),
  usage: usageSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  // 출처(활동 뷰 source 축): web|mcp|api|scorecard|schedule|front-door… 미설정=직접 API.
  trigger: z.string().optional(),
  // 이 run 이 속한 스코어카드 배치(있으면). 활동 리스트는 자식(값 있음)을 컨트롤플레인이 기본 제외.
  parentScorecardId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Run = z.infer<typeof runSchema>
export type RunStatus = Run['status']

export const runsSchema = z.array(runSchema)
