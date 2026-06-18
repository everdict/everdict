import { z } from 'zod'

// 컨트롤플레인 RunRecord 의 클라이언트 미러(필요한 필드만). 웹은 HTTP 로만 결합 — 백엔드 패키지 비의존.
export const scoreSchema = z.object({
  graderId: z.string(),
  metric: z.string(),
  value: z.number(),
  pass: z.boolean().optional(),
})

export const runSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  result: z.object({ scores: z.array(scoreSchema).default([]) }).partial().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Run = z.infer<typeof runSchema>
export type Score = z.infer<typeof scoreSchema>

export const runsSchema = z.array(runSchema)
