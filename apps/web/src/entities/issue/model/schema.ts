import type {
  IssueGithub as WireIssueGithub,
  IssueLink as WireIssueLink,
  IssueLinkType as WireIssueLinkType,
  IssueRecord as WireIssueRecord,
  IssueResolution as WireIssueResolution,
  IssueStatus as WireIssueStatus,
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
export const ISSUE_LINK_TYPES = ['harness', 'dataset', 'judge', 'scorecard', 'run', 'view'] as const
export const issueLinkTypeSchema = z.enum(ISSUE_LINK_TYPES)

export const issueLinkSchema = z.object({
  type: issueLinkTypeSchema,
  id: z.string(),
  version: z.string().optional(),
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
  title: z.string(),
  description: z.string().optional(),
  status: issueStatusSchema,
  projectId: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).default([]),
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

export type Issue = WireIssueRecord
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
]
