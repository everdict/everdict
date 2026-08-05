import { z } from "zod";

// Notification feed — the web bell inbox/desktop native notifications consume "the job I asked for is done".
// Personally owned (recipient=subject) + workspace-scoped — same self-scoped model as connections/runners.
// Design: docs/architecture/notifications.md (N1~N5).
export const NotificationKindSchema = z.enum([
  "run_completed",
  "run_failed",
  "scorecard_completed",
  "scorecard_failed",
  "schedule_completed", // a scheduled eval (cron fire or manual "run now") finished — branded with "Scheduled run"
  "schedule_failed",
  "report_completed", // a scheduled analysis report was produced — links to the view's report artifact (analysis-studio V4)
  "comment_mention", // @-mentioned in a comment — the link jumps straight to that context (dataset comment)
  // A resolved tracker issue stopped holding: a later batch on the same dataset+harness scored below the
  // scorecard that closed it (docs/tracker.md). The one notification worth interrupting someone for, because
  // nobody is watching a closed issue — that is exactly why it needs to come find them.
  "issue_regressed",
  // Somebody reported on work you are answerable for — a project or the goal above it (docs/tracker.md). ONE
  // kind for both levels: the reader's interest is the same ("the thing I am on got a status report"), the
  // link says which record, and the title carries the health. Two kinds would fork the bell's icon table
  // without forking any decision the reader makes.
  "tracker_update_posted",
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationRecordSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  recipient: z.string(), // the person who asked for the job (subject) — N2
  kind: NotificationKindSchema,
  title: z.string(),
  body: z.string().optional(),
  // Where a click navigates. `resourceType`+`resourceId` name the SUBJECT — the thing the notification is
  // about — and win over runId/scorecardId, which may be the evidence attached to it (a regression carries
  // both: the issue it happened to, and the scorecard that proved it). resourceType is the comment-target
  // vocabulary (`COMMENT_RESOURCE_TYPES`): dataset|harness|scorecard|view|schedule|run|runtime|issue|cycle|
  // project|initiative — the reader (`notificationHref` in the web, `notificationPathOf` in the desktop shell)
  // must have an address for every one of them, or the click silently lands on the workspace home.
  // commentId/artifactId say what ON that page it is about (carried as `?comment=`/`?artifact=`).
  link: z
    .object({
      runId: z.string().optional(),
      scorecardId: z.string().optional(),
      resourceType: z.string().optional(),
      resourceId: z.string().optional(),
      commentId: z.string().optional(),
      artifactId: z.string().optional(), // report notifications anchor the view's report artifact (analysis-studio V4)
    })
    .optional(),
  createdAt: z.string(),
  readAt: z.string().optional(),
});
export type NotificationRecord = z.infer<typeof NotificationRecordSchema>;
