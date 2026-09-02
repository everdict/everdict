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
// 우선순위 — Linear 의 다섯 단계. 정수(0~4)가 아니라 문자열 어휘인 건 컨트롤 플레인과 같은 이유다:
// 0 이 마지막으로 정렬되는 매직 넘버는 읽을 수 없다.
export const ISSUE_PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const
export const issuePrioritySchema = z.enum(ISSUE_PRIORITIES)

// `issue` 는 GitHub 이 `#123` 으로 적는 교차참조다 — 한 이슈가 다른 이슈를 언급한다. 저장은 다른 링크와
// 똑같이 **언급하는 쪽** 레코드에 한 방향으로만 하고, 언급당한 이슈는 하네스와 같은 역방향 질의로 읽는다.
// id 는 대상의 UUID 다(식별자가 아니다): 팀을 옮기면 `ENG-12` 가 `PLT-3` 로 다시 찍히므로.
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
  // 팀 이동 — 식별자를 다시 찍는 유일한 전이라 별도 이벤트다.
  'moved',
  // 프로젝트 업데이트가 올라왔다 — 타임라인을 훑는 사람이 찾는 건 그 사이의 편집이 아니라 이것들이다.
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
  // 이슈는 정확히 한 팀에 속하고, 그 팀이 찍은 이름(`ENG-12`)을 들고 다닌다.
  teamId: z.string(),
  number: z.number(),
  identifier: z.string(),
  // 팀을 옮기면 식별자를 다시 찍는다 — 예전 이름도 계속 해석되므로, 이미 붙여넣은 링크는 살아 있고
  // 상세 페이지는 정규 슬러그로 리다이렉트한다.
  formerIdentifiers: z.array(z.string()).default([]),
  title: z.string(),
  description: z.string().optional(),
  status: issueStatusSchema,
  // 상태(워크플로 위치)와 독립적인 긴급도. 기본값이 있는 이유는 "우선순위 없음"도 목록이 그려야 하는
  // 진짜 답이기 때문 — optional 이면 소비자마다 같은 폴백을 새로 발명한다.
  priority: issuePrioritySchema.default('none'),
  estimate: z.number().optional(),
  dueDate: z.string().optional(),
  parentId: z.string().optional(),
  // 이 이슈가 끌려 들어간 팀 이터레이션.
  cycleId: z.string().optional(),
  // 이슈가 속한 프로젝트 체크포인트 — 자기 프로젝트의 것만 가리킬 수 있다.
  milestoneId: z.string().optional(),
  // 트리아지 — 팀 워크플로 바깥(임포트·에이전트·요청)에서 들어와 아직 받아들여지지 않은 상태. 상태가 아니라
  // 플래그인 이유는 상태 어휘가 곧 워크플로이고, 워크플로에 들어오기 전인 것은 그 어휘로 말할 수 없기 때문.
  inTriage: z.boolean().default(false),
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

// 목록 행이 받는 축약본 — `GET /issues` 는 전체 레코드가 아니라 이 투영을 페이지 단위로 준다.
// 행이 그리지 않는 것(본문·이력·former identifiers·origin)은 아예 내려오지 않고, links 는 개수만,
// GitHub 사본은 "어느 저장소, 당겨오는가" 두 가지로 줄어든다. 전체 레코드는 상세(`getIssue`)에 있다.
export const issueSummaryGithubSchema = z.object({
  host: z.string().optional(),
  repository: z.string(),
  pull: z.boolean(),
})

export const issueSummarySchema = z.object({
  id: z.string(),
  tenant: z.string(),
  teamId: z.string(),
  number: z.number(),
  identifier: z.string(),
  title: z.string(),
  status: issueStatusSchema,
  priority: issuePrioritySchema.default('none'),
  estimate: z.number().optional(),
  dueDate: z.string().optional(),
  parentId: z.string().optional(),
  // 이 이슈가 끌려 들어간 팀 이터레이션.
  cycleId: z.string().optional(),
  milestoneId: z.string().optional(),
  // 트리아지 — 팀 워크플로 바깥(임포트·에이전트·요청)에서 들어와 아직 받아들여지지 않은 상태. 상태가 아니라
  // 플래그인 이유는 상태 어휘가 곧 워크플로이고, 워크플로에 들어오기 전인 것은 그 어휘로 말할 수 없기 때문.
  inTriage: z.boolean().default(false),
  projectId: z.string().optional(),
  assignee: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
  linkCount: z.number(),
  // 이 이슈에 달린 대화의 양(답글 포함). 이슈 테이블이 아니라 댓글 저장소가 아는 값이라 서버가 페이지마다
  // 집계 한 번으로 채운다. 없음(undefined) = 아무도 세지 않았다, 0 = 세었고 없다 — 둘은 다른 사실이다.
  commentCount: z.number().optional(),
  resolution: issueResolutionSchema.optional(),
  github: issueSummaryGithubSchema.optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

// 한 페이지 — `nextCursor` 가 없으면 마지막 장이다(하우스 페이지네이션 모양).
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
// 목록 행의 타입 — 상세(`Issue`)와 다른 타입인 게 요점이다. 행이 본문이나 이력을 읽으려 하면 컴파일이 막는다.
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
