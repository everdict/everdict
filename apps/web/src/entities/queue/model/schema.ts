import { z } from 'zod'

// 컨트롤플레인 GET /queue(QueueSnapshot) 미러 — 작업 큐: 런타임 레인별 실행 중/대기/다음 예약.
// 단위는 배치(스코어카드)=1작업(진행률 포함) + 단발 run=1작업. 자식 run 은 배치의 진행률로 접힌다.

export const queueItemSchema = z.object({
  type: z.enum(['scorecard', 'run']),
  id: z.string(),
  status: z.enum(['queued', 'running']),
  dataset: z.object({ id: z.string(), version: z.string() }).optional(), // 스코어카드만
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string().optional(), // 단발 run 만
  trigger: z.string().optional(), // 어디서 발사됐나(web|api|schedule|github-actions…)
  createdBy: z.string().optional(), // 실행자 subject
  createdAt: z.string(),
  // 배치 진행률(실행 중 스코어카드만). total 은 데이터셋 해석 실패 시 생략.
  progress: z
    .object({ done: z.number(), active: z.number(), total: z.number().optional() })
    .optional(),
})
export type QueueItem = z.infer<typeof queueItemSchema>

export const queueUpcomingSchema = z.object({
  scheduleId: z.string(),
  name: z.string(),
  at: z.string(),
  dataset: z.string(),
  harness: z.string(),
})
export type QueueUpcoming = z.infer<typeof queueUpcomingSchema>

export const queueLaneSchema = z.object({
  runtime: z.string(), // '' = 기본 백엔드, 'self:<id>' = 셀프호스티드 러너
  registered: z.boolean(),
  running: z.array(queueItemSchema),
  queued: z.array(queueItemSchema), // FIFO — 맨 앞이 다음 작업
  upcoming: z.array(queueUpcomingSchema),
})
export type QueueLane = z.infer<typeof queueLaneSchema>

export const queueSnapshotSchema = z.object({
  generatedAt: z.string(),
  totals: z.object({ running: z.number(), queued: z.number(), upcoming: z.number() }),
  lanes: z.array(queueLaneSchema),
})
export type QueueSnapshot = z.infer<typeof queueSnapshotSchema>
