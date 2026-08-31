import type { ScorecardRow } from '@/entities/scorecard'
import type { ListDisplay, ListFilters } from '@/shared/lib/list-view'

// The scorecards list's view and its data, in a module the CLIENT may import. The loader beside it is
// `server-only` — a barrel that re-exports both drags `server-only` into the browser bundle, which is exactly
// how this screen failed to build the first time. Types cost nothing at runtime; the reads stay on the server.

export interface ScorecardView {
  filters: ListFilters
  search: string
  display: ListDisplay
}

export interface ScorecardViewGroup {
  key: string | null
  // The SERVER's count. Never the rows received — this screen holds a page, so counting what it has would
  // report the page size back to itself.
  count: number
  items: ScorecardRow[]
}

export interface ScorecardViewData {
  groups: ScorecardViewGroup[]
  // How many batches match the current narrow, and how many of them are loaded. The screen says both: a
  // silent window reads as "that is all of them".
  total: number
  loaded: number
  // The cursor for the next page — present exactly when there is more to load.
  nextCursor?: { createdAt: string; id: string }
  // Per axis, the values present in the narrowed collection with their counts.
  facets: Record<string, { value: string; count: number }[]>
  // A read that failed is not an empty list. The screen must say so rather than draw "no batches".
  error?: string
}
