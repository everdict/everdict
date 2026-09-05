import 'server-only'

import {
  issueGroupCountsSchema,
  issueGroupsToRender,
  issuePageSchema,
  issueQueryFilters,
  orderIssueGroups,
  type IssueGroupBy,
  type IssueGroupCount,
  type IssuePage,
  type IssueSummary,
  type IssueView,
} from '@/entities/issue'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

import type { IssuePageQuery } from '../model/page-query'

// The **data** of one issue list screen. The point is that the server component (the first render) and the server action (a view change)
// call the SAME function: with two copies, the list after changing a filter and the list after a refresh could differ.
//
// Why a view change does not re-render the whole route is obvious once counted. It used to be that turning on one filter made
// `router.push` re-render the page, and that render re-read everything unrelated to the list (members, projects, cycles, labels, the team
// roster, GitHub App state) before drawing anything — and the screen was a skeleton the whole time.
// Now only what this function returns is re-fetched, and the previous list stays on screen while it is.

// How many rows one group draws first. A grouped screen gives each group its own page, and "show more" extends only that group.
const GROUP_PAGE = 25
// One page of an ungrouped list.
const FLAT_PAGE = 50
// How many cards one board column draws — it is a screen you SWEEP, so instead of paginating inside a column, the column states how many it could not draw.
const BOARD_PAGE = 20
// The cap on how many groups a screen stands up. It stops a 200-person workspace grouped by assignee from becoming 200 queries, while
// leaving the fact that it truncated ON the screen (a silent cap reads as "you have seen everything").
const MAX_GROUPS = 20

// What this is a list OF — the narrowing decided by the **address** rather than by filters. Team, triage and cycle are where the screen
// STANDS, so they do not change when the view does.
export interface IssueViewBase {
  team?: string
  triage?: boolean
  cycle?: string
}

export interface IssueViewRequest {
  base: IssueViewBase
  view: IssueView
}

export interface IssueViewGroup {
  key: string | null
  // The count the server aggregate made. Counting the received rows only restates the page size.
  count: number
  items: IssueSummary[]
  nextCursor?: string
  // The query that fetches this group's next page — used verbatim by "show more".
  query: IssuePageQuery
}

export interface IssueViewData {
  groupBy?: IssueGroupBy
  total?: number
  groups: IssueViewGroup[]
  flat?: { items: IssueSummary[]; nextCursor?: string }
  flatQuery?: IssuePageQuery
  // How many groups were not stood up — non-zero, and the screen says so.
  droppedGroups: number
  // When the list itself could not be read. An aggregate failure has its own kind because the screen has to say something different:
  // a grouped screen has no grounds to draw without the aggregate, and falling back to "no issues" would call existing issues absent.
  error?: { kind: 'counts' } | { kind: 'load'; message: string }
}

// This list's narrowing. Built once so that the rows and the group counts use the **same** filters.
// A cycle scope OVERRIDES the URL's cycle filter — this screen is "that iteration's board" rather than "the issue list narrowed by cycle",
// so a filter must not be able to overturn what the address already answered.
export function issueScopeOf({ base, view }: IssueViewRequest): IssuePageQuery {
  return {
    ...issueQueryFilters(view),
    ...(base.team !== undefined ? { team: base.team } : {}),
    ...(base.triage === true ? { triage: true } : {}),
    ...(base.cycle !== undefined ? { cycle: [base.cycle] } : {}),
  }
}

// The query that picks ONE group — the whole list's narrowing plus that group's single value. The unspecified bucket is the empty string
// (a query parameter has no null). It overrides even an existing filter on that axis: this request is "this group", not
// "this group ∩ the values the user picked", and the group list itself already came through those filters.
function groupQuery(
  scope: IssuePageQuery,
  groupBy: IssueGroupBy,
  group: IssueGroupCount,
  order: string,
  limit: number
): IssuePageQuery {
  const value = group.key ?? ''
  const facet =
    groupBy === 'status'
      ? { status: [value] }
      : groupBy === 'priority'
        ? { priority: [value] }
        : groupBy === 'assignee'
          ? { assignee: [value] }
          : groupBy === 'project'
            ? { project: [value] }
            : { cycle: [value] }
  return { ...scope, ...facet, order, limit }
}

export async function loadIssueViewData(
  ctx: AuthContext,
  request: IssueViewRequest
): Promise<IssueViewData> {
  const { view } = request
  const scope = issueScopeOf(request)

  if (view.grouping === 'none') {
    const query: IssuePageQuery = { ...scope, order: view.order, limit: FLAT_PAGE }
    try {
      const page = issuePageSchema.parse(await controlPlane.listIssues(ctx, query))
      return {
        groups: [],
        flat: {
          items: page.items,
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        },
        flatQuery: query,
        droppedGroups: 0,
      }
    } catch (e) {
      return {
        groups: [],
        droppedGroups: 0,
        error: { kind: 'load', message: e instanceof Error ? e.message : String(e) },
      }
    }
  }

  const counts = await controlPlane
    .countIssues(ctx, view.grouping, scope)
    .then((r) => issueGroupCountsSchema.parse(r))
    .catch(() => undefined)
  if (counts === undefined) return { groups: [], droppedGroups: 0, error: { kind: 'counts' } }

  const rendered = orderIssueGroups(
    issueGroupsToRender(counts.groups, counts.groupBy, view),
    counts.groupBy
  )
  const shown = rendered.slice(0, MAX_GROUPS)
  const perGroupLimit = view.layout === 'board' ? BOARD_PAGE : GROUP_PAGE

  const pages = await Promise.all(
    shown.map((group) =>
      // An empty group is not queried — a board's empty column (a place to drop something) must not cost a round trip.
      group.count === 0
        ? Promise.resolve<IssuePage | undefined>({ items: [] })
        : controlPlane
            .listIssues(ctx, groupQuery(scope, counts.groupBy, group, view.order, perGroupLimit))
            .then((r) => issuePageSchema.parse(r))
            .catch((): IssuePage | undefined => undefined)
    )
  )

  return {
    groupBy: counts.groupBy,
    total: counts.total,
    groups: shown.map((group, index) => {
      const page = pages[index]
      return {
        key: group.key,
        count: group.count,
        items: page?.items ?? [],
        ...(page?.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        query: groupQuery(scope, counts.groupBy, group, view.order, perGroupLimit),
      }
    }),
    droppedGroups: rendered.length - shown.length,
  }
}
