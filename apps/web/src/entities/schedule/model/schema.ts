import { z } from 'zod'

// 컨트롤플레인 예약(cron) 스코어카드의 클라이언트 미러. 웹은 HTTP 로만 결합 — @everdict/* 비의존.
// GET /schedules 응답: 워크스페이스의 예약 목록. 발사(Temporal)는 컨트롤플레인 책임.
export const scheduleOverlapPolicySchema = z.enum(['skip', 'bufferOne', 'allowAll'])
export type ScheduleOverlapPolicy = z.infer<typeof scheduleOverlapPolicySchema>

export const scheduleRunTemplateSchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }),
  judges: z.array(z.object({ id: z.string(), version: z.string() })).default([]),
  runtime: z.string().optional(),
  concurrency: z.number().optional(),
})

export const scheduleSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  overlapPolicy: scheduleOverlapPolicySchema,
  enabled: z.boolean(),
  createdBy: z.string(),
  runTemplate: scheduleRunTemplateSchema,
  lastFiredAt: z.string().optional(),
  lastStatus: z.string().optional(),
  lastScorecardId: z.string().optional(),
  // Temporal 이 계산한 authoritative 다음 발사 시각(ISO). 컨트롤플레인이 드라이버로 부착 —
  // 없으면(Temporal 미배포) 웹이 cron 으로 근사한다. 비저장·읽기 전용.
  nextFireTimes: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Schedule = z.infer<typeof scheduleSchema>
export const schedulesSchema = z.array(scheduleSchema)
