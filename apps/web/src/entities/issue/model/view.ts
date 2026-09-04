import type {
  IssueGroupBy as WireIssueGroupBy,
  IssueGroupCount as WireIssueGroupCount,
  IssueGroupCounts as WireIssueGroupCounts,
  IssueOrder as WireIssueOrder,
} from '@everdict/contracts'
import { z } from 'zod'

import type { IssueDisplay } from './display'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, type IssuePriority, type IssueStatus } from './schema'

// What an issue list shows and how it is drawn. The two halves have different homes, and keeping the arithmetic
// between them in one module is what stops a filter chip and a group header from describing different lists:
//
//   · WHICH issues — the filters. They live in the URL, because they decide the SET and a pasted link has to
//     open the same set for everybody who follows it.
//   · HOW they are drawn — grouping, ordering, layout, the two "show these too" toggles. Per reader, stored in a
//     cookie (`./display`), because a link should not re-arrange the recipient's screen.
//
// Only the type crosses from `./display` — the runtime direction is display → view, never back.

// The grouping key. All of them are SCALAR fields of an issue, so one issue belongs to exactly one group — labels are excluded for the
// same reason as in the control plane (one issue carries several labels, so the groups would sum to more than the list).
export const ISSUE_GROUP_BYS = ['status', 'assignee', 'priority', 'project'] as const
export const issueGroupBySchema = z.enum(ISSUE_GROUP_BYS)
export type IssueGroupBy = WireIssueGroupBy

// Ungrouped, as one flat list — a separate value rather than one of the grouping keys. The control plane's `groupBy` exists for the
// AGGREGATE, so it has no answer for "not grouped" (there is nothing to aggregate).
export const ISSUE_GROUPINGS = ['none', ...ISSUE_GROUP_BYS] as const
export const issueGroupingSchema = z.enum(ISSUE_GROUPINGS)
export type IssueGrouping = (typeof ISSUE_GROUPINGS)[number]

export const ISSUE_ORDERS = ['updated', 'created', 'priority', 'due'] as const
export const issueOrderSchema = z.enum(ISSUE_ORDERS)
export type IssueOrder = WireIssueOrder

// List or board. A board stands its groups up as columns, so it cannot coexist with "ungrouped" — `issueViewOf` folds that combination
// back to grouping by status (a screen that means something, rather than an empty one).
export const ISSUE_LAYOUTS = ['list', 'board'] as const
export const issueLayoutSchema = z.enum(ISSUE_LAYOUTS)
export type IssueLayout = (typeof ISSUE_LAYOUTS)[number]

export const issueGroupCountSchema = z.object({
  key: z.string().nullable(),
  count: z.number(),
})

export const issueGroupCountsSchema = z.object({
  groupBy: issueGroupBySchema,
  groups: z.array(issueGroupCountSchema),
  total: z.number(),
})

export type IssueGroupCount = WireIssueGroupCount
export type IssueGroupCounts = WireIssueGroupCounts

// One screen, fully determined: the reader's display preference plus the filters the URL carries.
export interface IssueView extends IssueDisplay {
  filters: IssueFilters
}

// A filter is "any of these" per axis. ABSENT, rather than an empty array, is "that axis is not filtered" — an empty array means
// "something was picked and it was nothing", and the control plane is right to return nothing for it.
export interface IssueFilters {
  status?: IssueStatus[]
  priority?: IssuePriority[]
  // The empty string is "unassigned" — a query parameter has no null, and that bucket is a group people genuinely filter by.
  assignee?: string[]
  label?: string[]
  project?: string[]
  cycle?: string[]
}

export const ISSUE_FILTER_FACETS = [
  'status',
  'priority',
  'assignee',
  'label',
  'project',
] as const
export type IssueFilterFacet = (typeof ISSUE_FILTER_FACETS)[number]

// Completed/cancelled — what "show completed issues" turns back on. A regression is deliberately not here: an
// issue whose verdict stopped holding is not finished work.
const COMPLETED_STATUSES: IssueStatus[] = ['done', 'cancelled']

// The names the URL carries. Filters only — display options are the reader's and live in a cookie, so they never
// appear here. Spelled in full rather than abbreviated because a pasted address is read by people.
export type IssueViewParams = {
  status?: string | string[]
  priority?: string | string[]
  assignee?: string | string[]
  label?: string | string[]
  project?: string | string[]
  cycle?: string | string[]
  cursor?: string
}

// One or many, always as an array. `?status=todo&status=done` is how a set is spelled.
function asArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

// Closed vocabularies only — anything can be typed into an address bar, so an unknown value is dropped rather
// than passed through (a list that 400s is worse than a list that ignores one word).
function pickAll<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[]
): T[] | undefined {
  const raw = asArray(value)
  if (raw === undefined) return undefined
  return raw.filter((item): item is T => allowed.some((option) => option === item))
}

// The two halves joined: filters read off the URL, display handed in by whoever read the reader's cookie. An
// unrecognised filter value is silently dropped, so no address a user can type produces a screen that errors.
export function issueViewOf(params: IssueViewParams, display: IssueDisplay): IssueView {
  const filters: IssueFilters = {
    ...(pickAll(params.status, ISSUE_STATUSES) !== undefined
      ? { status: pickAll(params.status, ISSUE_STATUSES) }
      : {}),
    ...(pickAll(params.priority, ISSUE_PRIORITIES) !== undefined
      ? { priority: pickAll(params.priority, ISSUE_PRIORITIES) }
      : {}),
    ...(asArray(params.assignee) !== undefined ? { assignee: asArray(params.assignee) } : {}),
    ...(asArray(params.label) !== undefined ? { label: asArray(params.label) } : {}),
    ...(asArray(params.project) !== undefined ? { project: asArray(params.project) } : {}),
    ...(asArray(params.cycle) !== undefined ? { cycle: asArray(params.cycle) } : {}),
  }
  return { ...display, filters }
}

// Screen → URL. Filters only, and never the display: an address that carried the reader's grouping would impose
// it on whoever the link is sent to, which is exactly what moving those to a cookie was for.
export function issueViewQuery(view: IssueView): URLSearchParams {
  const q = new URLSearchParams()
  for (const facet of ISSUE_FILTER_FACETS) {
    for (const value of view.filters[facet] ?? []) q.append(facet, value)
  }
  return q
}

// This screen's address. The cursor is never inherited — it is a position in a different list, so a changed view
// always starts from page one.
export function issueViewHref(basePath: string, view: IssueView): string {
  const qs = issueViewQuery(view).toString()
  return `${basePath}${qs ? `?${qs}` : ''}`
}

// Toggle one value on an axis — the only action of the filter menu. Turning the LAST value off removes the axis itself (left as an empty
// array it becomes "an axis with nothing picked" and the list empties entirely).
export function toggleIssueFilter(
  filters: IssueFilters,
  facet: IssueFilterFacet,
  value: string
): IssueFilters {
  const current = filters[facet] ?? []
  const next = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value]
  const { [facet]: _dropped, ...rest } = filters
  return next.length === 0 ? rest : { ...rest, [facet]: next }
}

export function issueFilterCount(filters: IssueFilters): number {
  return ISSUE_FILTER_FACETS.reduce((sum, facet) => sum + (filters[facet]?.length ?? 0), 0)
}

// The screen → the control plane query. This is where "hide completed" is translated into a status filter: the only vocabulary the server
// understands is a status SET, and an explicit user choice of statuses wins (a UI default overriding an explicit choice is a defect).
export function issueQueryFilters(view: IssueView): IssueFilters & { parent?: string } {
  const status =
    view.filters.status ??
    (view.showCompleted ? undefined : ISSUE_STATUSES.filter((s) => !COMPLETED_STATUSES.includes(s)))
  return {
    ...view.filters,
    ...(status !== undefined ? { status } : {}),
    ...(view.subIssues === 'top' ? { parent: 'none' } : {}),
  }
}

// The order the groups are drawn in. For status and priority the vocabulary IS the order (in-progress has to sit above backlog for it to
// read as a board); people, projects and cycles have no name order, so the control plane's "largest group first" is followed verbatim.
const STATUS_BOARD_ORDER: IssueStatus[] = [
  'regressed',
  'in_progress',
  'in_review',
  'todo',
  'backlog',
  'done',
  'cancelled',
]

export function orderIssueGroups(
  groups: readonly IssueGroupCount[],
  groupBy: IssueGroupBy
): IssueGroupCount[] {
  const vocabulary: readonly string[] | undefined =
    groupBy === 'status'
      ? STATUS_BOARD_ORDER
      : groupBy === 'priority'
        ? ISSUE_PRIORITIES
        : undefined
  if (vocabulary === undefined) return [...groups]
  return [...groups].sort((a, b) => {
    if (a.key === null) return b.key === null ? 0 : 1
    if (b.key === null) return -1
    return vocabulary.indexOf(a.key) - vocabulary.indexOf(b.key)
  })
}

// The groups a board or grouped list actually stands up. The control plane counts only groups that HAVE issues, but status and priority
// must **stand a column even when empty** — an "in progress" nobody is in disappearing makes the board read as though that column does
// not exist, and above all leaves nowhere to drag a card to.
export function issueGroupsToRender(
  counts: readonly IssueGroupCount[],
  groupBy: IssueGroupBy,
  view: IssueView
): IssueGroupCount[] {
  const seen = new Map(counts.map((group) => [group.key, group.count]))
  if (groupBy === 'status') {
    const columns = STATUS_BOARD_ORDER.filter(
      // Standing a done column on a screen with "show completed issues" turned off is always zero — it is showing back what was turned off.
      (status) =>
        view.filters.status?.includes(status) ??
        (view.showCompleted || !COMPLETED_STATUSES.includes(status))
    )
    return columns.map((status) => ({ key: status, count: seen.get(status) ?? 0 }))
  }
  if (groupBy === 'priority') {
    return ISSUE_PRIORITIES.filter(
      (priority) => view.filters.priority?.includes(priority) ?? true
    ).map((priority) => ({ key: priority, count: seen.get(priority) ?? 0 }))
  }
  // The remaining axes have an OPEN vocabulary — standing a column for every workspace member fills the screen with empty slots for
  // people who never received an issue. Only the groups the control plane counted, in the order it counted them (largest first).
  return [...counts]
}

// The drift guard — the local vocabulary and the wire contract must be mutually assignable.
type AssertAssignable<A extends B, B> = A
type _groupByFwd = AssertAssignable<z.infer<typeof issueGroupBySchema>, WireIssueGroupBy>
type _groupByBack = AssertAssignable<WireIssueGroupBy, z.infer<typeof issueGroupBySchema>>
type _orderFwd = AssertAssignable<z.infer<typeof issueOrderSchema>, WireIssueOrder>
type _orderBack = AssertAssignable<WireIssueOrder, z.infer<typeof issueOrderSchema>>
type _countsFwd = AssertAssignable<z.infer<typeof issueGroupCountsSchema>, WireIssueGroupCounts>
type _countsBack = AssertAssignable<WireIssueGroupCounts, z.infer<typeof issueGroupCountsSchema>>

export type __issueViewDriftGuard = [
  _groupByFwd,
  _groupByBack,
  _orderFwd,
  _orderBack,
  _countsFwd,
  _countsBack,
]
