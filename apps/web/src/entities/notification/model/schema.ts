import { z } from 'zod'

// 알림 피드 미러 — 컨트롤플레인 GET /notifications (docs/architecture/notifications.md).
// 개인 소유(recipient=subject) — "내가 시킨 작업이 끝났다"를 벨 인박스/네이티브 알림이 소비.
export const notificationKinds = [
  'run_completed',
  'run_failed',
  'scorecard_completed',
  'scorecard_failed',
  'schedule_regression',
] as const
export const notificationKindSchema = z.enum(notificationKinds)
export type NotificationKind = z.infer<typeof notificationKindSchema>

export const notificationSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  recipient: z.string(),
  kind: notificationKindSchema,
  title: z.string(),
  body: z.string().optional(),
  link: z.object({ runId: z.string().optional(), scorecardId: z.string().optional() }).optional(),
  createdAt: z.string(),
  readAt: z.string().optional(),
})
export type NotificationItem = z.infer<typeof notificationSchema>

export const notificationsResponseSchema = z.object({ notifications: z.array(notificationSchema) })
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>

export const readNotificationsResponseSchema = z.object({ read: z.number() })
