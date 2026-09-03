import type { ListDisplay } from '@/shared/lib/list-view'

import type { ScorecardRow } from './list-row'

// The batch list's vocabulary. Two things set it apart from the other three evaluation lists, and both come
// from what a scorecard IS — an event a CI run files rather than a registry entry a human authors:
//
// ① the collection only grows, so this list READS A PAGE. Every axis below is applied by the control plane
//    (`GET /scorecards`), and the group headers come from `GET /scorecards/counts`. Nothing here filters an
//    array in the browser any more: a facet applied to a loaded window silently stops finding batches once
//    the workspace outgrows the window, which is the one thing a filter must never do.
// ② status is a closed vocabulary and its groups have an order — running above finished, so the screen
//    answers "what is happening" before "what happened" — and a batch can be grouped by the day it RAN,
//    because what people ask an event list is "what ran yesterday".
export const SCORECARD_FACETS = [
  'team',
  'status',
  'harness',
  'dataset',
  'runtime',
  'creator',
] as const
export const SCORECARD_GROUPINGS = [
  'none',
  'status',
  'day',
  'harness',
  'dataset',
  'team',
  'creator',
] as const

// Newest first, and only that. The ordering used to offer "by name" as well, which the store cannot page:
// applied to the loaded window it would re-sort a partial set and read as the whole one. "Which harness" is
// answered here by the facet and by the grouping, and both of those are exact.
export const SCORECARD_ORDERS = ['recent'] as const

export const DEFAULT_SCORECARD_DISPLAY: ListDisplay = { grouping: 'day', order: 'recent' }

// 상태 그룹의 순서 — 어휘 자체가 순서다.
const STATUS_ORDER = ['running', 'queued', 'failed', 'succeeded', 'cancelled', 'superseded']

// The bucket a row falls under, for a client arranging the page it holds under headers the SERVER counted.
// It must key a row exactly as the store does, or a row stands under a header that did not count it — which
// is why `day` is the ISO (UTC) date and not the reader's local one, mirroring `scorecardGroupKey` in
// @everdict/application-control.
export function scorecardGroupKeyOf(row: ScorecardRow, grouping: string): string | null {
  switch (grouping) {
    case 'status':
      return row.status
    case 'day':
      return row.createdAt.slice(0, 10)
    case 'harness':
      return row.harness.id
    case 'dataset':
      return row.dataset.id
    case 'creator':
      return row.createdBy ?? null
    default:
      return null
  }
}

// How the server's group rows are stood up. A closed vocabulary IS its own order; a date reads newest-first
// (어제가 지난달 아래에 서면 그건 목록이 아니다); everything else — people, teams, capabilities — has no
// order of its own, so the biggest group leads. The unset bucket goes last wherever it came from.
export function orderScorecardGroups<T extends { key: string | null; count: number }>(
  groups: readonly T[],
  grouping: string
): T[] {
  return [...groups].sort((a, b) => {
    if (a.key === null || b.key === null) return a.key === null ? (b.key === null ? 0 : 1) : -1
    if (grouping === 'status') return STATUS_ORDER.indexOf(a.key) - STATUS_ORDER.indexOf(b.key)
    if (grouping === 'day') return b.key.localeCompare(a.key)
    if (a.count !== b.count) return b.count - a.count
    return a.key.localeCompare(b.key)
  })
}
