import type {
  IssueGithub as WireIssueGithub,
  IssueLink as WireIssueLink,
  IssueLinkType as WireIssueLinkType,
  IssuePage as WireIssuePage,
  IssuePriority as WireIssuePriority,
  IssueRecord as WireIssueRecord,
  IssueResolution as WireIssueResolution,
  IssueStatus as WireIssueStatus,
  IssueSummary as WireIssueSummary,
  TrackerHistoryEntry as WireTrackerHistoryEntry,
} from '@everdict/contracts'
import type { IssueScorecardsResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

import { scorecardsSchema } from '@/entities/scorecard'

// The eval tracker's Issue — the unit of intent (docs/tracker.md). Runtime boundary validation stays here
// (zod v4); the EXPORTED types come from @everdict/contracts (`import type` only, re-architecture P4).

// Linear's six + `regressed`, which is why the tracker exists: a done issue whose evaluation later degraded
// carries the resolution it fell from and must read as an alarm, not as untouched work.
export const ISSUE_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
  'regressed',
] as const
export const issueStatusSchema = z.enum(ISSUE_STATUSES)

// OPEN = not done and not cancelled — a regressed issue blocks its initiative exactly like fresh work.
export const OPEN_ISSUE_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'regressed',
] as const

export function isOpenIssueStatus(status: WireIssueStatus): boolean {
  return status !== 'done' && status !== 'cancelled'
}

// What kind of everdict object an issue points at. Links are POINTERS — unvalidated by design, resolved
// through the normal RBAC-gated reads at render time.
// Priority — Linear's five levels. It is a string vocabulary rather than an integer (0–4) for the same reason as in the control
// plane: a magic number where 0 sorts last cannot be read.
export const ISSUE_PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const
export const issuePrioritySchema = z.enum(ISSUE_PRIORITIES)

// `issue` is the cross-reference GitHub writes as `#123` — one issue mentioning another. It is stored exactly like every other link,
// one-directionally on the **mentioning** record, and the mentioned issue is read by the same reverse query a harness uses.
// The id is the target's UUID (not its identifier): moving team re-stamps `ENG-12` as `PLT-3`.
export const ISSUE_LINK_TYPES = [
  'harness',
  'dataset',
  'judge',
  'scorecard',
  'run',
  'view',
  'issue',
  // The product timeline (records/product.ts) — "this issue blocks the 2026.3 release" is a link, and the
  // release gate counts its open linked issues through the same reverse query.
  'product',
  'release',
  // A case the issue is about — `id` is the case id, `dataset` + `version` the dataset version it lives in. A
  // campaign opened from the issue takes these as its targets (docs/architecture/evolution-routing-spec.md §3).
  'case',
] as const
export const issueLinkTypeSchema = z.enum(ISSUE_LINK_TYPES)

export const issueLinkSchema = z.object({
  type: issueLinkTypeSchema,
  id: z.string(),
  version: z.string().optional(),
  dataset: z.string().optional(), // case links only
  note: z.string().optional(),
  addedBy: z.string(),
  addedAt: z.string(),
})

// Durable, record-embedded history — the platform-event log is swept, so this is what can still answer
// "why did this regress last quarter".
export const trackerHistoryEventSchema = z.enum([
  'created',
  'updated',
  'status_changed',
  'resolved',
  'reopened',
  'linked',
  'unlinked',
  'github_imported',
  'github_pulled',
  'github_pushed',
  'github_push_failed',
  'completed',
  'cancelled',
  // A release went out (records/product.ts) — its own word, because "released" is what a reader scans a
  // product's history for, and a forced release must read as shipped-with-overrides, not done.
  'released',
  // A team move — its own event, because it is the only transition that RE-STAMPS the identifier.
  'moved',
  // A project update was posted — what someone sweeping the timeline is looking for is these, not the edits between them.
  'update_posted',
  'member_added',
  'member_removed',
])

export const trackerHistoryEntrySchema = z.object({
  at: z.string(),
  by: z.string(),
  event: trackerHistoryEventSchema,
  detail: z.record(z.string(), z.unknown()).optional(),
})

// How an issue was closed — the "how was it evaluated" half. `scorecardId` doubles as the baseline the
// regression watch compares later scorecards against.
export const issueResolutionSchema = z.object({
  scorecardId: z.string().optional(),
  note: z.string().optional(),
  by: z.string(),
  at: z.string(),
})

export const issueGithubSchema = z.object({
  host: z.string().optional(),
  repository: z.string(),
  number: z.number(),
  url: z.string(),
  state: z.enum(['open', 'closed']),
  syncedAt: z.string().optional(),
  sync: z.object({ pull: z.boolean(), push: z.boolean() }),
  comments: z
    .array(
      z.object({
        author: z.string(),
        body: z.string(),
        createdAt: z.string(),
        url: z.string(),
      })
    )
    .default([]),
  lastError: z
    .object({ at: z.string(), op: z.enum(['pull', 'push']), message: z.string() })
    .optional(),
})

export const issueSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  // An issue belongs to exactly one team and carries the name that team stamped (`ENG-12`).
  number: z.number(),
  identifier: z.string(),
  // Moving team re-stamps the identifier — an old name still resolves, so links already pasted stay alive and the detail page
  // redirects to the canonical slug.
  formerIdentifiers: z.array(z.string()).default([]),
  title: z.string(),
  description: z.string().optional(),
  status: issueStatusSchema,
  // Urgency, independent of status (the workflow position). It has a DEFAULT because "no priority" is a real answer a list has to
  // draw — left optional, every consumer invents the same fallback again.
  priority: issuePrioritySchema.default('none'),
  estimate: z.number().optional(),
  dueDate: z.string().optional(),
  parentId: z.string().optional(),
  // The team iteration this issue was pulled into.
  // The project checkpoint the issue belongs to — it can only point at one of its OWN project's.
  milestoneId: z.string().optional(),
  // Triage — arrived from outside the team workflow (an import, an agent, a request) and not yet accepted. It is a FLAG rather than a
  // status because the status vocabulary IS the workflow, and something not yet in the workflow cannot be said in that vocabulary.
  projectId: z.string().optional(),
  assignee: z.string().optional(),
  // Registry ids (entities/issue-label), not names — join against listIssueLabels to draw a chip.
  labelIds: z.array(z.string()).default([]),
  links: z.array(issueLinkSchema).default([]),
  resolution: issueResolutionSchema.optional(),
  github: issueGithubSchema.optional(),
  history: z.array(trackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  origin: z
    .object({ agentId: z.string().optional(), conversationId: z.string().optional() })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const issuesSchema = z.array(issueSchema)

// The summary a list row receives — `GET /issues` serves this projection a page at a time, not the whole record.
// What a row does not draw (the body, history, former identifiers, origin) never comes down at all; `links` shrinks to a count and
// the GitHub copy to two facts ("which repository" and "is it syncing"). The whole record is on the detail (`getIssue`).
export const issueSummaryGithubSchema = z.object({
  host: z.string().optional(),
  repository: z.string(),
  pull: z.boolean(),
})

export const issueSummarySchema = z.object({
  id: z.string(),
  tenant: z.string(),
  number: z.number(),
  identifier: z.string(),
  title: z.string(),
  status: issueStatusSchema,
  priority: issuePrioritySchema.default('none'),
  estimate: z.number().optional(),
  dueDate: z.string().optional(),
  parentId: z.string().optional(),
  // The team iteration this issue was pulled into.
  milestoneId: z.string().optional(),
  // Triage — arrived from outside the team workflow (an import, an agent, a request) and not yet accepted. It is a FLAG rather than a
  // status because the status vocabulary IS the workflow, and something not yet in the workflow cannot be said in that vocabulary.
  projectId: z.string().optional(),
  assignee: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
  linkCount: z.number(),
  // How much conversation this issue carries (replies included). The comment store knows it, not the issue table, so the server fills it
  // with one aggregate per page. Absent (undefined) = nobody counted; 0 = counted and there are none — two different facts.
  commentCount: z.number().optional(),
  resolution: issueResolutionSchema.optional(),
  github: issueSummaryGithubSchema.optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

// One page — no `nextCursor` means this is the last (the house pagination shape).
export const issuePageSchema = z.object({
  items: z.array(issueSummarySchema),
  nextCursor: z.string().optional(),
})

// GET /issues/:id/scorecards — pinned evidence UNION every batch the linked datasets/harnesses ran.
// The `scorecards` half reuses the scorecard entity's DELIBERATELY LOOSE view (guarded inside that slice);
// only `linked` is guarded here, because it is the one shape this endpoint owns.
export const issueScorecardsSchema = z.object({
  scorecards: scorecardsSchema,
  linked: z.array(z.string()),
})

// Drift guard — the local schema and the wire contract MUST stay mutually assignable (a server-side status
// or field change stops this compiling, forcing the lockstep update).
type AssertAssignable<A extends B, B> = A
type WebIssue = z.infer<typeof issueSchema>
type _issueFwd = AssertAssignable<WebIssue, WireIssueRecord>
type _issueBack = AssertAssignable<WireIssueRecord, WebIssue>
type _statusFwd = AssertAssignable<z.infer<typeof issueStatusSchema>, WireIssueStatus>
type _statusBack = AssertAssignable<WireIssueStatus, z.infer<typeof issueStatusSchema>>
type _linkTypeFwd = AssertAssignable<z.infer<typeof issueLinkTypeSchema>, WireIssueLinkType>
type _linkTypeBack = AssertAssignable<WireIssueLinkType, z.infer<typeof issueLinkTypeSchema>>
type _linkFwd = AssertAssignable<z.infer<typeof issueLinkSchema>, WireIssueLink>
type _linkBack = AssertAssignable<WireIssueLink, z.infer<typeof issueLinkSchema>>
type _resolutionFwd = AssertAssignable<z.infer<typeof issueResolutionSchema>, WireIssueResolution>
type _resolutionBack = AssertAssignable<WireIssueResolution, z.infer<typeof issueResolutionSchema>>
type _githubFwd = AssertAssignable<z.infer<typeof issueGithubSchema>, WireIssueGithub>
type _githubBack = AssertAssignable<WireIssueGithub, z.infer<typeof issueGithubSchema>>
type _historyFwd = AssertAssignable<
  z.infer<typeof trackerHistoryEntrySchema>,
  WireTrackerHistoryEntry
>
type _historyBack = AssertAssignable<
  WireTrackerHistoryEntry,
  z.infer<typeof trackerHistoryEntrySchema>
>
type _linkedFwd = AssertAssignable<
  z.infer<typeof issueScorecardsSchema>['linked'],
  IssueScorecardsResponse['linked']
>
type _linkedBack = AssertAssignable<
  IssueScorecardsResponse['linked'],
  z.infer<typeof issueScorecardsSchema>['linked']
>
type WebIssueSummary = z.infer<typeof issueSummarySchema>
type _summaryFwd = AssertAssignable<WebIssueSummary, WireIssueSummary>
type _summaryBack = AssertAssignable<WireIssueSummary, WebIssueSummary>
type _pageFwd = AssertAssignable<z.infer<typeof issuePageSchema>, WireIssuePage>
type _pageBack = AssertAssignable<WireIssuePage, z.infer<typeof issuePageSchema>>
type _priorityFwd = AssertAssignable<z.infer<typeof issuePrioritySchema>, WireIssuePriority>
type _priorityBack = AssertAssignable<WireIssuePriority, z.infer<typeof issuePrioritySchema>>

export type Issue = WireIssueRecord
// The list row's type — the POINT is that it differs from the detail (`Issue`). A row trying to read the body or the history fails to compile.
export type IssueSummary = WireIssueSummary
export type IssuePage = WireIssuePage
export type IssuePriority = WireIssuePriority
export type IssueStatus = WireIssueStatus
export type IssueLink = WireIssueLink
export type IssueLinkType = WireIssueLinkType
export type IssueResolution = WireIssueResolution
export type TrackerHistoryEntry = WireTrackerHistoryEntry
export type IssueScorecards = z.infer<typeof issueScorecardsSchema>

// Reference the guards so unused-type lint never strips them.
export type __issueDriftGuard = [
  _issueFwd,
  _issueBack,
  _statusFwd,
  _statusBack,
  _linkTypeFwd,
  _linkTypeBack,
  _linkFwd,
  _linkBack,
  _resolutionFwd,
  _resolutionBack,
  _githubFwd,
  _githubBack,
  _historyFwd,
  _historyBack,
  _linkedFwd,
  _linkedBack,
  _summaryFwd,
  _summaryBack,
  _pageFwd,
  _pageBack,
  _priorityFwd,
  _priorityBack,
]
