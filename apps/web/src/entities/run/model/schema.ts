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
    // os-use=데스크탑 스냅샷(screenshot=base64 PNG), browser=dom/url 등. screenshot 은 <img> 로 인라인 표시.
    snapshot: z
      .object({ kind: z.string(), screenshot: z.string().optional() })
      .passthrough()
      .optional(),
    harness: z.string().optional(),
  })
  .partial()

export const runSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  result: resultSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Run = z.infer<typeof runSchema>
export type RunStatus = Run['status']

export const runsSchema = z.array(runSchema)
