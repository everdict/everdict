import { z } from 'zod'

import {
  decodeKeyedPreference,
  encodeKeyedPreference,
  readPreferenceCookie,
  withKeyedPreference,
  writePreferenceCookie,
} from '@/shared/lib/keyed-preference'

import {
  ISSUE_GROUPINGS,
  ISSUE_LAYOUTS,
  ISSUE_ORDERS,
  issueGroupingSchema,
  issueLayoutSchema,
  issueOrderSchema,
  type IssueGrouping,
  type IssueLayout,
  type IssueOrder,
} from './view'

// HOW a list is drawn, as opposed to WHICH issues it draws. The split is Linear's and it is about what a pasted
// link should mean: a filter changes the SET of issues, so two people opening the same link must see the same
// set — it belongs in the URL. Grouping, ordering, layout and the two "show these too" toggles change nothing
// about the set, only about the reader's eyes, so sending someone a link should not re-arrange their screen.
// Those live here, per user, and survive across sessions instead of across links.
//
// The store is a COOKIE rather than localStorage because the list is a server component: it has to know the
// grouping before it can ask the control plane for group counts. localStorage is not readable at that point, so
// the first paint would be the default view and the chosen one would arrive as a flicker. Same reasoning (and
// the same shape) as the timezone preference in `shared/i18n/timezone.ts`.

export const ISSUE_DISPLAY_COOKIE = 'everdict-issue-display'

export interface IssueDisplay {
  grouping: IssueGrouping
  order: IssueOrder
  layout: IssueLayout
  // Show completed/cancelled issues too. Hidden by default for Linear's reason — a list is "what is left to do",
  // and finished work is usually not the answer to that question.
  showCompleted: boolean
  // Sub-issues on their own rows, or top-level only. The latter reads as one line per piece of work.
  subIssues: 'all' | 'top'
}

// The boundary schema. A display arrives from the browser through a server action, so it is validated like any
// other external input rather than trusted for having come from our own menu.
export const issueDisplaySchema = z.object({
  grouping: issueGroupingSchema,
  order: issueOrderSchema,
  layout: issueLayoutSchema,
  showCompleted: z.boolean(),
  subIssues: z.enum(['all', 'top']),
})

export const DEFAULT_ISSUE_DISPLAY: IssueDisplay = {
  grouping: 'status',
  order: 'updated',
  layout: 'list',
  showCompleted: false,
  subIssues: 'all',
}

// WHICH list a preference belongs to. Linear remembers display options per view, not per app, and the cookie
// keeps that shape: a key per view, capped. The workspace's issue list is one such view — its key is a constant
// because the workspace is the only boundary, so there is one issue list rather than one per team.
//
// The mechanism stays per-view (a saved analysis view, a board opened from a project, anything a later screen
// wants remembered separately) — what collapsed is the ADDRESS space of the issue list, not the store.
export const WORKSPACE_ISSUES_VIEW_KEY = 'workspace:issues'

// How many views the cookie remembers. A cookie rides every request, so this cannot grow without bound: past the
// cap the least-recently-changed view is dropped and simply reverts to the defaults next time it is opened.
const MAX_REMEMBERED_VIEWS = 12

// The wire form of one display: five fields in a fixed order, joined by `-`. Positional rather than named
// because no value in any of the five vocabularies contains a `-`, and a cookie — unlike a URL — is not read by
// people. Order: grouping, order, layout, completed, subIssues.
function encodeOne(display: IssueDisplay): string {
  return [
    display.grouping,
    display.order,
    display.layout,
    display.showCompleted ? '1' : '0',
    display.subIssues,
  ].join('-')
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.find((option) => option === value) ?? fallback
}

// A stored display is not trusted: it is a cookie, and the vocabularies it names can change under it when a
// grouping is renamed or removed. Every field falls back to its default independently, so one stale word costs
// that word rather than the whole preference.
function decodeOne(raw: string): IssueDisplay {
  const [grouping, order, layout, completed, sub] = raw.split('-')
  return normalizeIssueDisplay({
    grouping: pick(grouping, ISSUE_GROUPINGS, DEFAULT_ISSUE_DISPLAY.grouping),
    order: pick(order, ISSUE_ORDERS, DEFAULT_ISSUE_DISPLAY.order),
    layout: pick(layout, ISSUE_LAYOUTS, DEFAULT_ISSUE_DISPLAY.layout),
    showCompleted: completed === '1',
    subIssues: sub === 'top' ? 'top' : 'all',
  })
}

// A board draws its columns FROM the grouping, so an ungrouped board has nothing to draw. Normalising to status
// here (rather than at one call site) means every path into a display — cookie, default, a fresh choice — lands
// on a screen that renders something.
export function normalizeIssueDisplay(display: IssueDisplay): IssueDisplay {
  if (display.layout !== 'board' || display.grouping !== 'none') return display
  return { ...display, grouping: 'status' }
}

// The whole cookie: view key → display, most recently changed first. The map layer is shared with every other
// per-view preference (`shared/lib/keyed-preference`) — it escapes the `:` in a view key and answers with the
// last value for a repeated key, so a hand-edited cookie cannot produce two answers for one view.
export function decodeIssueDisplays(cookie: string | undefined): Map<string, IssueDisplay> {
  const entries = new Map<string, IssueDisplay>()
  for (const [key, value] of decodeKeyedPreference(cookie)) entries.set(key, decodeOne(value))
  return entries
}

export function encodeIssueDisplays(entries: Map<string, IssueDisplay>): string {
  const encoded = new Map<string, string>()
  for (const [key, display] of entries) encoded.set(key, encodeOne(display))
  return encodeKeyedPreference(encoded)
}

// The display for one view, defaults when this reader has never chosen one.
export function issueDisplayFor(cookie: string | undefined, viewKey: string): IssueDisplay {
  return decodeIssueDisplays(cookie).get(viewKey) ?? DEFAULT_ISSUE_DISPLAY
}

// One view's choice written back into the cookie. The changed view moves to the front, which is what makes the
// cap evict the view nobody has touched in longest rather than an arbitrary one.
export function withIssueDisplay(
  cookie: string | undefined,
  viewKey: string,
  display: IssueDisplay
): string {
  return withKeyedPreference(
    cookie,
    viewKey,
    encodeOne(normalizeIssueDisplay(display)),
    MAX_REMEMBERED_VIEWS
  )
}

// 브라우저에서 바로 써 넣는다 — 서버 액션 왕복 없이. 표시 설정은 데이터가 아니라 취향이고, 이 쿠키는
// httpOnly 가 아니다(서버가 첫 화면을 그릴 때 읽는 것이 유일한 용도다). 액션을 한 번 다녀오는 동안 화면이
// 기다릴 이유가 없어서, 지금 화면은 클라이언트 상태로 즉시 바뀌고 쿠키는 다음 방문을 위해 남는다.
export function saveIssueDisplay(viewKey: string, display: IssueDisplay): void {
  writePreferenceCookie(
    ISSUE_DISPLAY_COOKIE,
    withIssueDisplay(readPreferenceCookie(ISSUE_DISPLAY_COOKIE), viewKey, display)
  )
}

// The schema and the type say the same thing, in both directions — adding a field to one without the other stops
// compiling rather than silently dropping that field at the action boundary.
type AssertAssignable<A extends B, B> = A
export type __issueDisplayGuard = [
  AssertAssignable<z.infer<typeof issueDisplaySchema>, IssueDisplay>,
  AssertAssignable<IssueDisplay, z.infer<typeof issueDisplaySchema>>,
]
