import 'server-only'

import {
  orderScorecardGroups,
  SCORECARD_FACETS,
  scorecardGroupCountsSchema,
  scorecardGroupKeyOf,
  scorecardsSchema,
  toScorecardRow,
  type ScorecardRow,
} from '@/entities/scorecard'
import { controlPlane, type AuthContext, type ScorecardListQuery } from '@/shared/lib/control-plane'

import type { ScorecardView, ScorecardViewData, ScorecardViewGroup } from '../model/view'

// The scorecards list screen's DATA. The server component (first paint) and the server action (the view
// changed) call this one function, because two of them is how "after a filter" and "after a refresh" come to
// describe different lists.
//
// Why the list reads a page at all: a scorecard is an event a CI run files, so the collection only grows.
// This screen used to read the workspace's entire history — every navigation — and then filter it in the
// browser. Now every axis is applied by the control plane, and the numbers the page cannot know (the total,
// each group's size) come from the counts door under the SAME narrow. A page whose header counted a
// different set from the rows beneath it is the defect that door exists to prevent.

// One page of rows. 200 is the control plane's own ceiling, and it is generous on purpose: a workspace under
// that reads exactly once and never sees the boundary at all.
const PAGE = 200

// The axes whose OPTIONS are read from the counts door — "only the values that are actually there", which is
// what a facet menu owes its reader. They are fetched with the page rather than lazily because the filter
// menu has to be able to open with them, and each is one indexed GROUP BY.
const FACET_AXES = SCORECARD_FACETS

// The view → the control plane's query. ONE place, so the rows, the counts and the facet options can never be
// narrowed differently.
export function scorecardQueryOf(view: ScorecardView): ScorecardListQuery {
  const set = (facet: string): readonly string[] | undefined => {
    const values = view.filters[facet]
    return values !== undefined && values.length > 0 ? values : undefined
  }
  const statuses = set('status')
  const datasets = set('dataset')
  const harnesses = set('harness')
  const runtimes = set('runtime')
  const creators = set('creator')
  const teams = set('team')
  return {
    ...(statuses !== undefined ? { statuses } : {}),
    ...(datasets !== undefined ? { datasets } : {}),
    ...(harnesses !== undefined ? { harnesses } : {}),
    ...(runtimes !== undefined ? { runtimes } : {}),
    ...(creators !== undefined ? { creators } : {}),
    ...(teams !== undefined ? { teams } : {}),
    ...(view.search.trim() !== '' ? { q: view.search.trim() } : {}),
  }
}

export async function loadScorecardViewData(
  ctx: AuthContext,
  view: ScorecardView,
  // Continuing an existing page: the rows already on screen, and where they stopped. The rows are passed in
  // rather than re-read, so "load older" appends instead of re-fetching what the reader is looking at.
  more?: { rows: ScorecardRow[]; before: { createdAt: string; id: string } }
): Promise<ScorecardViewData> {
  const query = scorecardQueryOf(view)
  const grouping = view.display.grouping

  // The page, the totals, and each facet's options — one round trip each, all of them narrowed identically.
  // `+1` on the page is how "is there more" is answered without a second question: ask for one past the page
  // and, if it arrives, drop it and remember the cursor.
  const [page, counts, ...facetCounts] = await Promise.allSettled([
    controlPlane
      .listScorecards(ctx, {
        ...query,
        limit: PAGE + 1,
        ...(more !== undefined ? { before: more.before } : {}),
      })
      .then((r) => scorecardsSchema.parse(r).map(toScorecardRow)),
    controlPlane
      .countScorecards(ctx, grouping === 'none' ? 'day' : grouping, query)
      .then((r) => scorecardGroupCountsSchema.parse(r)),
    ...FACET_AXES.map((axis) =>
      controlPlane
        .countScorecards(ctx, axis, query)
        .then((r) => scorecardGroupCountsSchema.parse(r))
    ),
  ])

  if (page.status === 'rejected') {
    return {
      groups: [],
      total: 0,
      loaded: 0,
      facets: {},
      error: page.reason instanceof Error ? page.reason.message : String(page.reason),
    }
  }

  const fetched = page.value
  const hasMore = fetched.length > PAGE
  const fresh = hasMore ? fetched.slice(0, PAGE) : fetched
  const rows = more === undefined ? fresh : [...more.rows, ...fresh]
  const last = rows[rows.length - 1]

  // A failed COUNT is not zero batches — it is a number we could not get. The rows are already in hand, so
  // the screen still draws them; what it must not do is print a total it does not have, which is why the
  // fallback is the loaded count and the grouping falls back to one flat section.
  const total = counts.status === 'fulfilled' ? counts.value.total : rows.length

  const facets: Record<string, { value: string; count: number }[]> = {}
  FACET_AXES.forEach((axis, index) => {
    const result = facetCounts[index]
    if (result === undefined || result.status !== 'fulfilled') return
    facets[axis] = result.value.groups.map((group) => ({
      value: group.key ?? '',
      count: group.count,
    }))
  })

  return {
    groups: groupRows(
      rows,
      grouping,
      counts.status === 'fulfilled' ? counts.value.groups : undefined
    ),
    total,
    loaded: rows.length,
    ...(hasMore && last !== undefined
      ? { nextCursor: { createdAt: last.createdAt, id: last.id } }
      : {}),
    facets,
  }
}

// The rows in hand, arranged under the headers the server counted. The rows arrive in the store's order, so a
// group's members are contiguous whenever the grouping follows that order (the default — by day) and merely
// scattered otherwise; either way the header's number is the server's and the rows beneath it are what has
// been loaded so far, which is exactly what the "n of m loaded" line under the toolbar says.
function groupRows(
  rows: ScorecardRow[],
  grouping: string,
  counted: readonly { key: string | null; count: number }[] | undefined
): ScorecardViewGroup[] {
  if (grouping === 'none')
    return [{ key: null, count: counted === undefined ? rows.length : 0, items: rows }]

  const held = new Map<string | null, ScorecardRow[]>()
  for (const row of rows) {
    const key = scorecardGroupKeyOf(row, grouping)
    const bucket = held.get(key)
    if (bucket) bucket.push(row)
    else held.set(key, [row])
  }
  // Stand the groups the SERVER named — that is the set, and it includes buckets whose rows are further down
  // the collection than this page reached. A group the server did not name but the page holds cannot exist
  // (the counts and the rows were narrowed identically), so it would be a bug rather than a case to handle.
  const groups =
    counted === undefined
      ? [...held].map(([key, items]) => ({ key, count: items.length, items }))
      : counted.map((group) => ({
          key: group.key,
          count: group.count,
          items: held.get(group.key) ?? [],
        }))
  return orderScorecardGroups(groups, grouping)
}
