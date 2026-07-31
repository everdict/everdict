import { z } from "zod";

// The EVAL TRACKER — Initiative ⊃ Project ⊃ Issue (docs/tracker.md). Everdict's primitives (harnesses, datasets,
// judges, scorecards) answer "what ran"; the tracker answers "why we evaluate at all". An Issue is the unit of
// intent — the problem under evaluation — and it gathers the capabilities that verify it, so a team discusses at
// the issue level: how it was resolved, which scorecard closed it, and why it came back. Projects group issues
// under a target date; an Initiative is the deployment umbrella whose readiness gates a release.
// Linear's Teams layer is deliberately omitted: a workspace already IS the team boundary.

// --- Issue status (Linear's six + one) ---
// `regressed` is our addition and the reason the tracker exists: a done issue whose evaluation later degraded is
// NOT the same as an untouched todo — it carries a resolution (the baseline it fell from) and reads as an alarm.
// OPEN = anything that is not done/cancelled, so a regressed issue blocks its initiative exactly like fresh work.
export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
  "regressed",
] as const;
export const IssueStatusSchema = z.enum(ISSUE_STATUSES);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

// What kind of everdict object an issue points at. Links are POINTERS (same semantics as a platform event's
// subject) — unvalidated by design, resolved through the normal RBAC-gated reads at render time. The one
// exception is `resolution.scorecardId`, which the service validates because it is evidence, not a pointer.
export const ISSUE_LINK_TYPES = ["harness", "dataset", "judge", "scorecard", "run", "view"] as const;
export const IssueLinkTypeSchema = z.enum(ISSUE_LINK_TYPES);
export type IssueLinkType = z.infer<typeof IssueLinkTypeSchema>;

export const IssueLinkSchema = z.object({
  type: IssueLinkTypeSchema,
  id: z.string().min(1),
  // Absent = "this capability, any version" — which is what a long-lived issue usually means (a harness keeps
  // evolving while the issue stays the same). Pinning a version is the exception, not the default.
  version: z.string().optional(),
  note: z.string().max(500).optional(),
  addedBy: z.string(),
  addedAt: z.string(),
});
export type IssueLink = z.infer<typeof IssueLinkSchema>;

// --- Durable history (record-embedded, NOT the platform-event log) ---
// The event log is swept (deleteOlderThan), so it cannot be the answer to "why did this regress six months ago".
// The tracker's history rides on the record itself — the ScorecardRecord.steps precedent — and the matching
// platform facts are emitted in parallel for the LIVE plumbing (feed, agent triggers, Mattermost).
export const TRACKER_HISTORY_EVENTS = [
  "created",
  "updated",
  "status_changed",
  "resolved",
  "reopened",
  "linked",
  "unlinked",
  "github_imported",
  "github_pulled",
  "github_pushed",
  "github_push_failed",
  "completed",
  "cancelled",
] as const;
export const TrackerHistoryEventSchema = z.enum(TRACKER_HISTORY_EVENTS);
export type TrackerHistoryEvent = z.infer<typeof TrackerHistoryEventSchema>;

export const TrackerHistoryEntrySchema = z.object({
  at: z.string(),
  by: z.string(),
  event: TrackerHistoryEventSchema,
  detail: z.record(z.unknown()).optional(),
});
export type TrackerHistoryEntry = z.infer<typeof TrackerHistoryEntrySchema>;

// The domain caps history at this length (oldest dropped) so sync churn cannot grow a row without bound.
export const TRACKER_HISTORY_LIMIT = 200;

// --- What caused a status transition (fact payload + history detail) ---
// Facts, not judgments: `regression` states that a linked scorecard's pass rate fell below the resolution
// scorecard's — arithmetic over sealed results, never an inference about flakiness.
export const ISSUE_STATUS_CAUSES = ["manual", "github_sync", "regression"] as const;
export const IssueStatusCauseSchema = z.enum(ISSUE_STATUS_CAUSES);
export type IssueStatusCause = z.infer<typeof IssueStatusCauseSchema>;

// How an issue was closed — the "how was it evaluated" half of the tracker's promise. `scorecardId` is the
// evidence, and it doubles as the baseline the regression watch compares later scorecards against.
export const IssueResolutionSchema = z.object({
  scorecardId: z.string().optional(),
  note: z.string().max(2000).optional(),
  by: z.string(),
  at: z.string(),
});
export type IssueResolution = z.infer<typeof IssueResolutionSchema>;

// --- GitHub copy + manual sync state ---
// Ownership split (docs/tracker.md): GitHub owns title/description/labels/comments and the open↔closed
// state-of-record; everdict owns the status nuance (in_progress/in_review/regressed), projectId, links,
// resolution and assignee. Pull lets the remote win on GitHub-owned fields; push writes state + a comment.
// There is no field-level merge, and no inbound webhook — everdict stays the client (workspace-scoped-integrations.md).
export const IssueGithubCommentSchema = z.object({
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});
export type IssueGithubComment = z.infer<typeof IssueGithubCommentSchema>;

// Capped so an issue with a thousand-comment thread cannot bloat the row — the newest slice is the context a
// reader (or an agent) actually needs; the full thread is one click away on GitHub.
export const ISSUE_GITHUB_COMMENT_LIMIT = 50;

export const IssueGithubSyncSchema = z.object({
  // Pull is manual-but-default-on (a member presses Sync); push is opt-in because it writes to someone else's
  // tracker — closing a GitHub issue is not a side effect anyone should get by surprise.
  pull: z.boolean(),
  push: z.boolean(),
});
export type IssueGithubSync = z.infer<typeof IssueGithubSyncSchema>;

export const IssueGithubErrorSchema = z.object({
  at: z.string(),
  op: z.enum(["pull", "push"]),
  message: z.string(),
});
export type IssueGithubError = z.infer<typeof IssueGithubErrorSchema>;

export const IssueGithubSchema = z.object({
  // Unset = github.com; set = the deployment's GitHub Enterprise host (same convention as WorkspaceCiLink).
  host: z.string().optional(),
  repository: z.string().min(1), // "owner/name"
  number: z.number().int().positive(),
  url: z.string(),
  state: z.enum(["open", "closed"]),
  // The remote's own `updated_at` at the last successful pull — a REMOTE clock reading, so clock skew between
  // the control plane and GitHub can never make us skip an update. It also suppresses the echo of our own push.
  syncedAt: z.string().optional(),
  sync: IssueGithubSyncSchema,
  comments: z.array(IssueGithubCommentSchema).default([]),
  // Sync is best-effort by contract: a failure is recorded here and surfaced in the UI, never thrown at the
  // member whose local transition already succeeded.
  lastError: IssueGithubErrorSchema.optional(),
});
export type IssueGithub = z.infer<typeof IssueGithubSchema>;

export const IssueRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: IssueStatusSchema,
  projectId: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).default([]),
  links: z.array(IssueLinkSchema).default([]),
  // Set when the issue reached `done`. Kept across a reopen — a regressed issue must remember the scorecard it
  // fell from, which is exactly the baseline the regression watch needs.
  resolution: IssueResolutionSchema.optional(),
  github: IssueGithubSchema.optional(),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  // Agent attribution when a conversation created the issue (the causedBy loop guard keys on it).
  origin: z
    .object({
      agentId: z.string().optional(),
      conversationId: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueRecord = z.infer<typeof IssueRecordSchema>;

// --- Project: issues under one target date ---
export const PROJECT_STATUSES = ["planned", "in_progress", "completed", "cancelled"] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

// Calendar dates, not instants: "did we finish evaluation by the 14th" is a date question, and storing the
// literal YYYY-MM-DD round-trips exactly with no timezone reinterpretation on the way in or out.
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

export const ProjectRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  status: ProjectStatusSchema,
  initiativeId: z.string().optional(),
  targetDate: CalendarDateSchema.optional(),
  completedAt: z.string().optional(),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

// --- Initiative: the deployment umbrella ---
export const INITIATIVE_STATUSES = ["active", "completed", "cancelled"] as const;
export const InitiativeStatusSchema = z.enum(INITIATIVE_STATUSES);
export type InitiativeStatus = z.infer<typeof InitiativeStatusSchema>;

export const InitiativeRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  status: InitiativeStatusSchema,
  targetDate: CalendarDateSchema.optional(),
  completedAt: z.string().optional(),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InitiativeRecord = z.infer<typeof InitiativeRecordSchema>;

// --- Derived read models (computed on detail reads, never stored) ---
// Same treatment as ScorecardRecord.trialSummary: counting issues is cheap and always-fresh arithmetic, whereas
// a stored rollup is a cache to invalidate on every child write.
export const ProjectRollupSchema = z.object({
  total: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(), // not done and not cancelled — regressed counts here
  done: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  byStatus: z.record(IssueStatusSchema, z.number().int().nonnegative()),
  // Done AND closed with a scorecard — "resolved" and "resolved with evidence" are different claims, and a
  // release conversation cares about the second one.
  evaluated: z.number().int().nonnegative(),
  ready: z.boolean(), // open === 0
});
export type ProjectRollup = z.infer<typeof ProjectRollupSchema>;

export const InitiativeBlockerSchema = z.object({
  projectId: z.string().optional(),
  issueId: z.string(),
  title: z.string(),
  status: IssueStatusSchema,
});
export type InitiativeBlocker = z.infer<typeof InitiativeBlockerSchema>;

export const InitiativeProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: ProjectStatusSchema,
  targetDate: CalendarDateSchema.optional(),
  completedAt: z.string().optional(),
  rollup: ProjectRollupSchema,
});
export type InitiativeProjectSummary = z.infer<typeof InitiativeProjectSummarySchema>;

// The deployment verdict. `ready` counts open issues across every non-cancelled project REGARDLESS of that
// project's own status — a project marked completed whose issue later regressed still blocks the release. The
// project status is history; the initiative readiness is live truth.
export const InitiativeReadinessSchema = z.object({
  ready: z.boolean(),
  openIssues: z.number().int().nonnegative(),
  totalIssues: z.number().int().nonnegative(),
  projects: z.array(InitiativeProjectSummarySchema),
  blockers: z.array(InitiativeBlockerSchema), // capped — a readiness card lists what to fix, not everything
});
export type InitiativeReadiness = z.infer<typeof InitiativeReadinessSchema>;

export const INITIATIVE_BLOCKER_LIMIT = 20;
