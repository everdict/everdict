import { z } from "zod";

// The EVAL TRACKER — Initiative ⊃ Project ⊃ Issue (docs/tracker.md). Everdict's primitives (harnesses, datasets,
// judges, scorecards) answer "what ran"; the tracker answers "why we evaluate at all". An Issue is the unit of
// intent — the problem under evaluation — and it gathers the capabilities that verify it, so a team discusses at
// the issue level: how it was resolved, which scorecard closed it, and why it came back. Projects group issues
// under a target date; an Initiative is a GOAL several projects work toward — Linear's meaning, not a release
// train. Its progress is the live arithmetic over everything underneath, and completing it is a gate only
// because a goal with open work under it has not been reached yet.
// Teams (records/team.ts) group ISSUES inside a workspace and name them (`ENG-12`); projects and initiatives stay
// workspace-level on purpose, so a release several teams contribute to is still one readiness gate.

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

// --- Status CATEGORIES (Linear's five) ---
// Every status belongs to exactly one category, and category is what PROGRAMMATIC decisions read: the release
// gate, the rollups, the regression watch. Linear calls these the workflow-state `type`, and it is the reason a
// team can rename or add states without breaking anything — the name is for humans, the category is for code.
//
// `regressed` maps to `started`, which is the whole argument for having categories at all: a resolution that
// stopped holding is WORK IN FLIGHT, not an untouched backlog item and not a finished one. Every open/closed
// judgment in the tracker now derives from this table instead of repeating a pair of literals.
export const ISSUE_STATUS_CATEGORIES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;
export const IssueStatusCategorySchema = z.enum(ISSUE_STATUS_CATEGORIES);
export type IssueStatusCategory = z.infer<typeof IssueStatusCategorySchema>;

export const ISSUE_STATUS_CATEGORY: Record<IssueStatus, IssueStatusCategory> = {
  backlog: "backlog",
  todo: "unstarted",
  in_progress: "started",
  in_review: "started",
  done: "completed",
  cancelled: "canceled",
  regressed: "started",
};

// The CLOSED half of the vocabulary, DERIVED from the category table above rather than listed again — the
// stores' aggregate counts pass this very array into SQL, so "open" has to mean the same thing whether it is
// decided in TypeScript or by Postgres, and two hand-maintained lists would eventually disagree. `regressed` is
// absent because its category is `started`: a resolution that stopped holding is work in flight.
export const CLOSED_ISSUE_STATUSES: readonly IssueStatus[] = ISSUE_STATUSES.filter(
  (status) => ISSUE_STATUS_CATEGORY[status] === "completed" || ISSUE_STATUS_CATEGORY[status] === "canceled",
);

// Calendar dates, not instants: "did we finish evaluation by the 14th" is a date question, and storing the
// literal YYYY-MM-DD round-trips exactly with no timezone reinterpretation on the way in or out.
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// --- Priority (Linear's five) ---
// A closed STRING vocabulary rather than Linear's 0–4 integers (`none`=0, `urgent`=1 … `low`=4 on the wire
// there). The values mean the same thing; the spelling is ours because a magic integer whose zero sorts LAST
// is exactly the kind of encoded rule this codebase keeps out of records — `issuePriorityRank`
// (@everdict/domain) owns the ordering instead, in one place, where it can be read.
export const ISSUE_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;
export const IssuePrioritySchema = z.enum(ISSUE_PRIORITIES);
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;

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

// --- Issue labels: a workspace-level registry, referenced by id ---
// Labels are RECORDS, not the free strings they used to be (mig 0107 promoted the old string arrays). An issue
// stores `labelIds`, so renaming a label or recolouring it is one write that every issue sees at once — the
// property the string model could never have. The registry is workspace-wide (not per-team) because a workspace
// IS the tenant here, and one shared vocabulary is what makes a cross-team filter mean anything.
//
// Colour is a CLOSED vocabulary, not a hex string: the web maps each token to a theme token, so a label stays
// legible in light and dark and nobody can author an off-theme (or invisible) chip. Same rule as charts.
export const ISSUE_LABEL_COLORS = [
  "gray",
  "purple",
  "blue",
  "teal",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
] as const;
export const IssueLabelColorSchema = z.enum(ISSUE_LABEL_COLORS);
export type IssueLabelColor = z.infer<typeof IssueLabelColorSchema>;

export const IssueLabelRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  // Unique per workspace, compared case-insensitively by the store — "Flaky" and "flaky" are one label, which is
  // also what a GitHub import needs when it maps a remote name onto the registry.
  name: z.string().min(1).max(64),
  color: IssueLabelColorSchema,
  description: z.string().max(500).optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueLabelRecord = z.infer<typeof IssueLabelRecordSchema>;

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
  // An issue changed hands between teams. It is its own event rather than an `updated` with a changed field
  // because it re-mints the issue's IDENTIFIER: the durable answer to "why is this issue called PLT-3 when every
  // link in the pull request says ENG-12" lives here, and nowhere else once the event log is swept.
  "moved",
  // A project update was posted — the health judgment plus the sentence explaining it. Its own event because a
  // reader scanning the timeline is looking for exactly these, not for the edits between them.
  "update_posted",
  // Team roster changes (records/team.ts) — who could file under this prefix, and when. The durable half of the
  // matching `team.member_*` facts, for the same reason every other tracker history entry exists: the event log
  // is swept, and "who was on this team when that issue was filed" is a question asked long after.
  "member_added",
  "member_removed",
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
  // Every issue belongs to exactly one team — required, because "which team owns this" has no sensible empty
  // answer and an optional owner would grow an unowned bucket nobody triages. A caller that names no team gets
  // the workspace's default team, so the requirement costs the caller nothing.
  teamId: z.string(),
  // The team-scoped sequence and its rendered form (`ENG-12`). Stored rather than derived: the team key is
  // immutable, so the identifier is stable for the life of the issue and readable without loading the team.
  number: z.number().int().positive(),
  identifier: z.string().min(1),
  // Every identifier this issue has answered to before, oldest first. Moving an issue to another team re-mints
  // its name from the new team's counter (that is what makes the prefix mean "whose list is this on"), which
  // would otherwise break every link already pasted into a pull request or a chat message. Keeping the old
  // names resolvable — the lookup falls back to this list and the web redirects to the canonical slug — is what
  // lets the address change without any of its existing spellings dying.
  formerIdentifiers: z.array(z.string()).default([]),
  title: z.string().min(1),
  description: z.string().optional(),
  status: IssueStatusSchema,
  // How urgent, independent of where it sits in the workflow: a backlog item can be urgent and an in-progress
  // one can be nobody's priority. Defaulted rather than optional because "unprioritised" is a real answer that
  // every list has to draw, and an absent field would make every consumer invent the same fallback.
  priority: IssuePrioritySchema.default("none"),
  // Team-scoped points. A bare number here on purpose: the SCALE (linear / fibonacci / t-shirt) is a team
  // setting, so the same 3 renders as "3" or "M" depending on the owning team — the record stores the value,
  // never its rendering.
  estimate: z.number().int().nonnegative().max(1000).optional(),
  // When this issue is due — a calendar date like a project's target date, and for the same reason: "is it late"
  // is a date question, and the literal YYYY-MM-DD round-trips with no timezone reinterpretation.
  dueDate: CalendarDateSchema.optional(),
  // The issue this one breaks out of. Sub-issues are ordinary issues in every other respect — they carry their
  // own status, their own team, and count in every rollup — so this is a pointer, not a containment. The
  // service refuses a cycle (nothing may be its own ancestor) and refuses deleting an issue that still has
  // children rather than silently orphaning them.
  parentId: z.string().optional(),
  // The team iteration this issue is pulled into (records/cycle.ts). A cycle belongs to a team, so this only
  // ever names one of the OWNING team's cycles — the service refuses another team's, because an issue in a
  // cycle it cannot appear in is invisible work.
  cycleId: z.string().optional(),
  // The project checkpoint this issue belongs to. Only ever one of ITS project's milestones — the service
  // refuses another project's, because a checkpoint an issue cannot appear under is work made invisible.
  milestoneId: z.string().optional(),
  // Which of the owning team's named workflow states the issue sits in (records/workflow-state.ts). The
  // canonical `status` above stays the programmatic answer; this is the team's spelling of it, and absent means
  // "the team's default state for that status" — which is every issue that predates the board, and every one
  // the regression watch moved (nobody dragged it into a column).
  stateId: z.string().optional(),
  // Triage: the issue arrived from outside the team's workflow (an import, an agent, a request) and has not
  // been accepted into it yet. A flag rather than a status, deliberately — the status vocabulary is the
  // WORKFLOW, and something waiting to enter the workflow has not started it. Accepting clears the flag;
  // declining cancels the issue.
  inTriage: z.boolean().default(false),
  projectId: z.string().optional(),
  assignee: z.string().optional(),
  // Ids into the workspace label registry above — NOT names. A reader that needs to draw a chip joins against
  // `GET /issue-labels` (the same join the web already does for members and projects); a dangling id cannot
  // happen because deleting a label strips it from every issue in the same transaction.
  labelIds: z.array(z.string()).default([]),
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

// --- The LIST projection ---
// A list screen draws an identifier, a title, a status and a few chips; it never draws a description or an
// audit trail. Serving the full record anyway made `GET /issues` read and Zod-parse every row's `history` and
// `description` — 4 MB and 150 ms for a 2,000-issue workspace, of which the page used a few kilobytes. This is
// the same split `ScorecardStore.list` already makes by omitting per-case results: the LIST is a projection,
// the DETAIL (`GET /issues/:id`) stays the whole record.
//
// What is dropped and why: `description`/`history` (unbounded, detail-only), `formerIdentifiers`/`origin`
// (never rendered in a row), `links` → `linkCount` (rows show the count), and the GitHub copy → the three
// fields a row actually needs, because the full one carries a 50-comment slice.
export const IssueSummaryGithubSchema = z.object({
  host: z.string().optional(),
  repository: z.string().min(1),
  pull: z.boolean(), // whether the bulk sync's working set includes this issue
});
export type IssueSummaryGithub = z.infer<typeof IssueSummaryGithubSchema>;

export const IssueSummarySchema = z.object({
  id: z.string(),
  tenant: z.string(),
  teamId: z.string(),
  number: z.number().int().positive(),
  identifier: z.string().min(1),
  title: z.string().min(1),
  status: IssueStatusSchema,
  // Drawn in a row: the priority icon, the "late" treatment on a due date, the estimate chip, and the marker
  // that says this row is somebody's sub-issue. All four are scalars, so projecting them costs a row nothing.
  priority: IssuePrioritySchema.default("none"),
  estimate: z.number().int().nonnegative().optional(),
  dueDate: CalendarDateSchema.optional(),
  parentId: z.string().optional(),
  cycleId: z.string().optional(),
  milestoneId: z.string().optional(),
  stateId: z.string().optional(),
  inTriage: z.boolean().default(false),
  projectId: z.string().optional(),
  assignee: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
  linkCount: z.number().int().nonnegative(),
  // How much conversation is on this issue — the thread badge a list row carries, replies included. It does NOT
  // come from the issue table (comments are their own store), so `IssueService` fills it from one batched
  // count per page. Deliberately OPTIONAL rather than defaulted to 0: absent means "nobody counted", 0 means
  // "counted, and there are none". A default would make an unwired comment store report every issue as silent.
  commentCount: z.number().int().nonnegative().optional(),
  // Kept despite being detail-ish: a regressed row names the scorecard it fell from, and that is the one thing
  // a regression alarm has to show without a second read.
  resolution: IssueResolutionSchema.optional(),
  github: IssueSummaryGithubSchema.optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueSummary = z.infer<typeof IssueSummarySchema>;

// One PAGE of the issue list, in the house pagination shape (`{ items, nextCursor? }`, opaque base64url token,
// absent = last page) — the same contract `TrajectoryStore.list` serves.
export const IssuePageSchema = z.object({
  items: z.array(IssueSummarySchema),
  nextCursor: z.string().optional(),
});
export type IssuePage = z.infer<typeof IssuePageSchema>;

// --- How a list is ORDERED, and how it is GROUPED ---
// Both belong to the LIST, not to the record: an issue has no ordering, a screen does. They live in the
// contracts anyway because neither is something a caller can apply on top of a page it already holds — the
// ordering decides what the page CURSOR means (a token minted under one ordering cannot be read under
// another), and the grouping decides an aggregate only the store can compute.
export const ISSUE_ORDERS = ["updated", "created", "priority", "due"] as const;
export const IssueOrderSchema = z.enum(ISSUE_ORDERS);
export type IssueOrder = z.infer<typeof IssueOrderSchema>;

// The columns a list can be grouped by — each a SCALAR on the issue, so every row belongs to exactly one group
// and the count is a plain GROUP BY. Labels are deliberately absent: an issue carries several, so grouping by
// label would put one row in several groups and the group counts would add up to more than the list.
export const ISSUE_GROUP_BYS = ["status", "assignee", "priority", "project", "cycle"] as const;
export const IssueGroupBySchema = z.enum(ISSUE_GROUP_BYS);
export type IssueGroupBy = z.infer<typeof IssueGroupBySchema>;

// How many issues sit in each group, under the SAME filter the list is drawn with. A grouped list cannot get
// this from its rows: it holds one page per group, so counting what it received would report the page size.
// `key: null` is the UNSET bucket (no assignee, no project, no cycle) — a group a list has to draw, which is
// why it is a null key rather than a missing entry.
export const IssueGroupCountSchema = z.object({
  key: z.string().nullable(),
  count: z.number().int().nonnegative(),
});
export type IssueGroupCount = z.infer<typeof IssueGroupCountSchema>;

export const IssueGroupCountsSchema = z.object({
  groupBy: IssueGroupBySchema,
  groups: z.array(IssueGroupCountSchema),
  // Every issue the filter selects, groups included — the number a header shows next to the list's own name.
  total: z.number().int().nonnegative(),
});
export type IssueGroupCounts = z.infer<typeof IssueGroupCountsSchema>;

// --- Health (the "update" Linear posts) ---
// A judgment a HUMAN makes, unlike everything else the tracker records — which is exactly why it lives on a
// posted update with a body rather than being inferred from the rollup. "Behind on issue count" is arithmetic;
// "at risk" is somebody saying so, and the sentence they said it in is the useful half.
//
// ONE vocabulary for both levels a human reports on (a project and the goal it serves): the same three words
// mean the same three things, and two enums would have made "at risk" a different value depending on which
// screen you were reading.
export const TRACKER_HEALTH = ["on_track", "at_risk", "off_track"] as const;
export const TrackerHealthSchema = z.enum(TRACKER_HEALTH);
export type TrackerHealth = z.infer<typeof TrackerHealthSchema>;

export const ProjectUpdateRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  projectId: z.string(),
  health: TrackerHealthSchema,
  body: z.string().max(50_000),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type ProjectUpdateRecord = z.infer<typeof ProjectUpdateRecordSchema>;

// --- Milestones: the checkpoints inside a project ---
// Embedded on the project rather than a table of their own: there are a handful per project, they are never
// read without it, and an issue points at one by id. `sortOrder` is what makes them a SEQUENCE — milestones are
// steps toward a date, so the order is the meaning, not a display preference.
export const ProjectMilestoneSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  targetDate: CalendarDateSchema.optional(),
  sortOrder: z.number().int().nonnegative(),
});
export type ProjectMilestone = z.infer<typeof ProjectMilestoneSchema>;

// --- Project: issues under one target date ---
// Linear's six, under our spelling: `in_progress` is its "started" (the issue vocabulary already spells the
// middle of a workflow that way, and one product should not name the same idea twice). `backlog` is work that
// is not scheduled yet and `paused` is work that stopped without being abandoned — the distinction a status
// list that only knows planned/in_progress loses, which is how a stalled project keeps reading as active.
export const PROJECT_STATUSES = ["backlog", "planned", "in_progress", "paused", "completed", "cancelled"] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  status: ProjectStatusSchema,
  // The teams contributing to this project, and the reason it is a LIST: a project is the unit a release is
  // planned in, and a release only one team may join is not a release — it is that team's backlog with a date
  // on it. Stored rather than derived from the project's issues, because the derived answer was "no teams" for
  // exactly as long as the project was still being planned, which is when the question gets asked.
  //
  // **At least one, always.** An empty list used to be legal and mean "workspace-wide", which quietly made a
  // SECOND kind of project: one that appears in no team's sidebar and that no team's issues may join. There is
  // one kind of project, and it is somebody's work — naming no team at creation lands it on the workspace's
  // default team, the same courtesy `teamId` gets on an issue, so the requirement costs a caller nothing.
  teamIds: z.array(z.string()).min(1),
  // Who is answerable for the project, and who is on it. The lead is a subject (the same identity every other
  // actor field carries), and membership is a plain list rather than a roster table: a project's members are a
  // statement about this project, not a second workspace directory.
  lead: z.string().optional(),
  memberIds: z.array(z.string()).default([]),
  // The health of the LATEST update, kept on the project so a list row can show it without reading the update
  // timeline per row. Absent = nobody has posted an update, which is different from "on track".
  health: TrackerHealthSchema.optional(),
  // The checkpoints inside the project, in order.
  milestones: z.array(ProjectMilestoneSchema).default([]),
  // The initiatives this project rolls up into — also a list, because one project routinely serves two goals
  // (a migration that is both "Q3 reliability" and "cost down"), and forcing a single choice silently drops
  // whichever goal lost. Progress counts the project under EVERY initiative that claims it.
  initiativeIds: z.array(z.string()).default([]),
  targetDate: CalendarDateSchema.optional(),
  completedAt: z.string().optional(),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

// --- Initiative: the goal several projects work toward ---
// `planned` is where a goal starts: somebody is still deciding what it means and which projects serve it, and
// calling that "active" made every idea look like work in flight. Moving to `active` is the moment the work
// under it begins — a transition somebody makes, not a side effect of creating the record.
export const INITIATIVE_STATUSES = ["planned", "active", "completed", "cancelled"] as const;
export const InitiativeStatusSchema = z.enum(INITIATIVE_STATUSES);
export type InitiativeStatus = z.infer<typeof InitiativeStatusSchema>;

// A link out of the goal — the design doc, the dashboard, the thread where it was argued. Kept ON the record
// rather than in the description because a reader scanning a goal wants these as targets, not as prose they
// have to find; the same reason an issue's linked capabilities are a list and not a paragraph.
export const InitiativeResourceSchema = z.object({
  label: z.string().min(1).max(200),
  url: z.string().url().max(2000),
});
export type InitiativeResource = z.infer<typeof InitiativeResourceSchema>;

export const INITIATIVE_RESOURCE_LIMIT = 20;

export const InitiativeRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  // One emoji, so a goal is recognizable in a list before its name is read. Emoji rather than an icon set
  // because the vocabulary is then the platform's, not a table we have to keep extending — and rather than a
  // colour, because a colour needs a closed theme-mapped vocabulary (the LabelDot rule) and a goal picked from
  // a nine-swatch palette says less than 🎯 does.
  icon: z.string().max(8).optional(),
  status: InitiativeStatusSchema,
  // An initiative may sit under another one, so a big bet decomposes instead of flattening into a wall of
  // projects. Progress rolls UP: a parent counts its own projects plus every descendant's, which is the only
  // reading that keeps "how far along is this" true for the goal a human actually points at. The service
  // refuses a cycle (nothing may be its own ancestor) — a cycle would make that roll-up non-terminating.
  parentId: z.string().optional(),
  // Who is answerable for the goal. Same shape as a project's lead and for the same reason: a goal nobody is
  // named on is one nobody reports on, and the update timeline below is what they report through.
  lead: z.string().optional(),
  // Who else is on it. A statement about THIS goal, not a second workspace directory — the same reading a
  // project's member list has. Derivable-looking (the leads of its projects) but not the same claim: somebody
  // can be on the goal without owning any one project under it.
  memberIds: z.array(z.string()).default([]),
  // Where the goal is written down, measured, or argued.
  resources: z.array(InitiativeResourceSchema).default([]),
  // The health of the LATEST posted update, denormalized so a list row shows it without reading the timeline
  // per row. Absent = nobody has posted an update, which is NOT the same claim as "on track".
  health: TrackerHealthSchema.optional(),
  targetDate: CalendarDateSchema.optional(),
  completedAt: z.string().optional(),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InitiativeRecord = z.infer<typeof InitiativeRecordSchema>;

// The initiative's posted updates — the same judgment a project reports, one level up. Its own record rather
// than a project update with a nullable projectId: they are read as two separate timelines (a goal's update
// summarizes across projects), and a nullable owner column is how one table becomes two half-used ones.
export const InitiativeUpdateRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  initiativeId: z.string(),
  health: TrackerHealthSchema,
  body: z.string().max(50_000),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type InitiativeUpdateRecord = z.infer<typeof InitiativeUpdateRecordSchema>;

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
  // The blocker's human name (`ENG-12`) — carried so a readiness card can both NAME the issue and link to it by
  // the identifier the rest of the product addresses issues with, without re-reading the issue.
  identifier: z.string(),
  title: z.string(),
  status: IssueStatusSchema,
});
export type InitiativeBlocker = z.infer<typeof InitiativeBlockerSchema>;

export const InitiativeProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  // Which initiative actually claims this project: absent = this one directly, set = the descendant it came up
  // through. Progress is one flat number, but work that is still open has to say WHERE it sits.
  viaInitiativeId: z.string().optional(),
  status: ProjectStatusSchema,
  // Carried so the goal's project list can draw the same row the project list draws — the reported health and
  // who is answerable are the two things a reader scanning "where does this goal stand" asks per project.
  health: TrackerHealthSchema.optional(),
  lead: z.string().optional(),
  targetDate: CalendarDateSchema.optional(),
  completedAt: z.string().optional(),
  rollup: ProjectRollupSchema,
});
export type InitiativeProjectSummary = z.infer<typeof InitiativeProjectSummarySchema>;

// How far along the goal is. `ready` counts open issues across every non-cancelled project REGARDLESS of that
// project's own status — a project marked completed whose issue later regressed is still unfinished work under
// the goal. The project status is history; this is live truth, and it is what the completion gate reads.
export const InitiativeReadinessSchema = z.object({
  ready: z.boolean(),
  openIssues: z.number().int().nonnegative(),
  totalIssues: z.number().int().nonnegative(),
  projects: z.array(InitiativeProjectSummarySchema),
  blockers: z.array(InitiativeBlockerSchema), // capped — the card lists what is left to do, not everything
});
export type InitiativeReadiness = z.infer<typeof InitiativeReadinessSchema>;

export const INITIATIVE_BLOCKER_LIMIT = 20;
