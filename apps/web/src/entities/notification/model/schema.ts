import type {
  NotificationRecord,
  NotificationKind as WireNotificationKind,
} from '@everdict/contracts'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Notification feed mirror — control plane GET /notifications (docs/architecture/notifications.md).
// Personally owned (recipient=subject) — "a job I triggered finished" consumed by the bell inbox/native notification.
export const notificationKinds = [
  'run_completed',
  'run_failed',
  'scorecard_completed',
  'scorecard_failed',
  'schedule_completed',
  'schedule_failed',
  'report_completed',
  'comment_mention',
  // 닫아둔 이슈의 평가가 무너졌다 — 아무도 안 보고 있는 이슈라서, 이슈 쪽이 사람을 찾아와야 한다.
  'issue_regressed',
  // 프로젝트/목표에 판정이 올라왔다 — 그 일에 답할 사람에게 간다(docs/tracker.md).
  'tracker_update_posted',
] as const
export const notificationKindSchema = z.enum(notificationKinds)

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
      artifactId: z.string().optional(), // report notifications anchor the view's report artifact
    })
    .optional(),
  createdAt: z.string(),
  readAt: z.string().optional(),
})

export const notificationsResponseSchema = z.object({ notifications: z.array(notificationSchema) })
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>

export const readNotificationsResponseSchema = z.object({ read: z.number() })

// Drift guards — NotificationItem is identical-shape (the web models every NotificationRecord field, including
// the link sub-object, and no extra) and NotificationKind is an identical enum, so both guard bidirectionally.
type AssertAssignable<A extends B, B> = A
type WebNotification = z.infer<typeof notificationSchema>
type WebNotificationKind = z.infer<typeof notificationKindSchema>
type _itemFwd = AssertAssignable<WebNotification, NotificationRecord>
type _itemBack = AssertAssignable<NotificationRecord, WebNotification>
type _kindFwd = AssertAssignable<WebNotificationKind, WireNotificationKind>
type _kindBack = AssertAssignable<WireNotificationKind, WebNotificationKind>

// Exported names alias the contract types (consumers untouched: same NotificationItem / NotificationKind).
export type NotificationItem = NotificationRecord
export type NotificationKind = WireNotificationKind

export type __notificationDriftGuard = [_itemFwd, _itemBack, _kindFwd, _kindBack]
