import { z } from 'zod'

// Notification feed mirror — control plane GET /notifications (docs/architecture/notifications.md).
// Personally owned (recipient=subject) — "a job I triggered finished" consumed by the bell inbox/native notification.
export const notificationKinds = [
  'run_completed',
  'run_failed',
  'scorecard_completed',
  'scorecard_failed',
  'schedule_regression',
  'comment_mention',
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
  link: z
    .object({
      runId: z.string().optional(),
      scorecardId: z.string().optional(),
      resourceType: z.string().optional(),
      resourceId: z.string().optional(),
      commentId: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
  readAt: z.string().optional(),
})
export type NotificationItem = z.infer<typeof notificationSchema>

export const notificationsResponseSchema = z.object({ notifications: z.array(notificationSchema) })
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>

export const readNotificationsResponseSchema = z.object({ read: z.number() })
