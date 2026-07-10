import { z } from "zod";

// Notification feed — the web bell inbox/desktop native notifications consume "the job I asked for is done".
// Personally owned (recipient=subject) + workspace-scoped — same self-scoped model as connections/runners.
// Design: docs/architecture/notifications.md (N1~N5).
export const NotificationKindSchema = z.enum([
  "run_completed",
  "run_failed",
  "scorecard_completed",
  "scorecard_failed",
  "schedule_regression",
  "comment_mention", // @-mentioned in a comment — the link jumps straight to that context (dataset comment)
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationRecordSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  recipient: z.string(), // the person who asked for the job (subject) — N2
  kind: NotificationKindSchema,
  title: z.string(),
  body: z.string().optional(),
  // Where a click navigates — run/scorecard detail, or a resource comment (mention: to that detail via resourceType+resourceId +
  // scroll to the commentId anchor). resourceType ∈ dataset|harness|scorecard|view|schedule|run|runtime.
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
});
export type NotificationRecord = z.infer<typeof NotificationRecordSchema>;
