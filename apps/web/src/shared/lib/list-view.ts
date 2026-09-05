import {
  decodeKeyedPreference,
  readPreferenceCookie,
  withKeyedPreference,
  writePreferenceCookie,
} from './keyed-preference'

// The two halves that decide what one list screen SHOWS. It is a straight generalization of the grammar the issue list established,
// so the rules are the same (`entities/issue/model/view.ts` is the original and shares this module's vocabulary).
//
//   · **WHICH ones** — the filters. They decide the SET, so they live in the URL: a pasted link must open the same set for whoever receives it.
//   · **HOW it is drawn** — grouping and ordering. They leave the set alone and change only the eye, so they live in the READER's cookie:
//     a link must not rearrange the recipient's screen.
//
// The evaluation-resource lists (harnesses, datasets, judges, scorecards) fetch the whole collection at once, so all of this arithmetic
// happens in the browser — which is why turning a filter on and changing the grouping costs zero round trips.

export type ListFilters = Record<string, readonly string[]>

// How it is drawn. There is no layout (board) because these lists have no closed status axis worth standing up as columns —
// when one is needed, a field is added here exactly as the issue list has.
export interface ListDisplay {
  grouping: string
  order: string
}

// Toggle one value on an axis — the only action of the filter menu. Turning the LAST value off removes the axis itself: left as an empty
// array it means "something was picked and it was nothing", and the list empties entirely.
export function toggleListFilter(filters: ListFilters, facet: string, value: string): ListFilters {
  const current = filters[facet] ?? []
  const next = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value]
  const { [facet]: _dropped, ...rest } = filters
  return next.length === 0 ? rest : { ...rest, [facet]: next }
}

export function listFilterCount(filters: ListFilters): number {
  return Object.values(filters).reduce((sum, values) => sum + values.length, 0)
}

function asArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

// URL → filters. Only known axes are read — anything can be typed into an address bar, so an unknown name is DROPPED rather than made into a 400.
export function listFiltersOf(
  params: Record<string, string | string[] | undefined> | URLSearchParams,
  facets: readonly string[]
): ListFilters {
  const read = (facet: string): string[] | undefined =>
    params instanceof URLSearchParams
      ? params.getAll(facet).length > 0
        ? params.getAll(facet)
        : undefined
      : asArray(params[facet])
  const filters: Record<string, string[]> = {}
  for (const facet of facets) {
    const values = read(facet)
    if (values !== undefined && values.length > 0) filters[facet] = values
  }
  return filters
}

// Filters + the search term → this screen's query. Display settings never come here (which is why they went to the cookie).
export function listViewQuery(
  filters: ListFilters,
  facets: readonly string[],
  search?: string
): URLSearchParams {
  const q = new URLSearchParams()
  for (const facet of facets) {
    for (const value of filters[facet] ?? []) q.append(facet, value)
  }
  if (search !== undefined && search !== '') q.set('q', search)
  return q
}

// --- Applying ---

export interface ListGroup<T> {
  key: string | null
  items: T[]
}

// One resource list states its own vocabulary through these four functions — everything else (toggling, grouping, counting) is shared.
export interface ListViewSpec<T> {
  // The values this item has on that axis. There may be several (tags) and there may be none (unspecified — represented as the empty string).
  facetValues: (item: T, facet: string) => readonly string[]
  // The text a search sweeps.
  searchText: (item: T) => string
  // The group this item belongs to. null is the "unspecified" bucket.
  groupKey: (item: T, grouping: string) => string | null
  compare: (a: T, b: T, order: string) => number
  // The order the groups stand in. For a closed vocabulary the vocabulary IS the order (status); where the values have an order of their own
  // (a date) it is a comparator. Returning nothing means largest group first — the only sensible ordering for an axis whose names have no order (people, teams).
  groupOrder?: (
    grouping: string
  ) => readonly string[] | ((a: string, b: string) => number) | undefined
}

export interface ListViewInput {
  filters: ListFilters
  search: string
  display: ListDisplay
}

// What a screen actually draws. The counts are computed HERE, so the number in a header cannot disagree with the rows beneath it —
// unlike the issue list, where the server fetches one page per group, the whole collection is in hand here.
export function applyListView<T>(
  items: readonly T[],
  view: ListViewInput,
  spec: ListViewSpec<T>
): { total: number; groups: ListGroup<T>[] } {
  const needle = view.search.trim().toLocaleLowerCase()
  const matched = items.filter((item) => {
    if (needle !== '' && !spec.searchText(item).toLocaleLowerCase().includes(needle)) return false
    return Object.entries(view.filters).every(([facet, selected]) => {
      if (selected.length === 0) return true
      const values = spec.facetValues(item, facet)
      // An item with no value at all must be filterable as "unspecified" (the empty string) — it is a bucket people genuinely filter by.
      const effective = values.length === 0 ? [''] : values
      return effective.some((value) => selected.includes(value))
    })
  })
  const sorted = [...matched].sort((a, b) => spec.compare(a, b, view.display.order))
  if (view.display.grouping === 'none') {
    return { total: sorted.length, groups: [{ key: null, items: sorted }] }
  }

  const buckets = new Map<string | null, T[]>()
  for (const item of sorted) {
    const key = spec.groupKey(item, view.display.grouping)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [item])
    else bucket.push(item)
  }
  const vocabulary = spec.groupOrder?.(view.display.grouping)
  const groups = [...buckets].map(([key, groupItems]) => ({ key, items: groupItems }))
  groups.sort((a, b) => {
    // The unspecified bucket is always LAST — a nameless group mixed in among named ones reads as debris rather than as a list.
    if (a.key === null || b.key === null) return a.key === null ? (b.key === null ? 0 : 1) : -1
    if (typeof vocabulary === 'function') return vocabulary(a.key, b.key)
    if (vocabulary !== undefined) return vocabulary.indexOf(a.key) - vocabulary.indexOf(b.key)
    if (a.items.length !== b.items.length) return b.items.length - a.items.length
    return a.key.localeCompare(b.key)
  })
  return { total: sorted.length, groups }
}

// --- Persisting the display settings ---

export const LIST_DISPLAY_COOKIE = 'everdict-list-display'

// How many screens the cookie remembers. It rides on every request, so it needs a cap (the same reason and the same number as the issue list's).
const MAX_REMEMBERED_VIEWS = 12

// A screen's two display fields are written as `group-order`. Position distinguishes them because neither vocabulary contains a `-`, and
// because a cookie, unlike a URL, is not read by people.
function encodeOne(display: ListDisplay): string {
  return `${display.grouping}-${display.order}`
}

function pick(value: string | undefined, allowed: readonly string[], fallback: string): string {
  return allowed.find((option) => option === value) ?? fallback
}

export interface ListDisplayVocabulary {
  groupings: readonly string[]
  orders: readonly string[]
  fallback: ListDisplay
}

// A stored setting is not trusted — it is a cookie, and the vocabulary underneath it can change (a grouping key renamed or removed).
// Each field falls back to its default separately, so one stale word costs only that word.
export function listDisplayFor(
  cookie: string | undefined,
  viewKey: string,
  vocabulary: ListDisplayVocabulary
): ListDisplay {
  const raw = decodeKeyedPreference(cookie).get(viewKey)
  if (raw === undefined) return vocabulary.fallback
  const [grouping, order] = raw.split('-')
  return {
    grouping: pick(grouping, vocabulary.groupings, vocabulary.fallback.grouping),
    order: pick(order, vocabulary.orders, vocabulary.fallback.order),
  }
}

export function withListDisplay(
  cookie: string | undefined,
  viewKey: string,
  display: ListDisplay
): string {
  return withKeyedPreference(cookie, viewKey, encodeOne(display), MAX_REMEMBERED_VIEWS)
}

// Written straight from the browser — with no server-action round trip. It is the value the server reads the NEXT time this screen opens,
// and the current screen has already changed through client state.
export function saveListDisplay(viewKey: string, display: ListDisplay): void {
  writePreferenceCookie(
    LIST_DISPLAY_COOKIE,
    withListDisplay(readPreferenceCookie(LIST_DISPLAY_COOKIE), viewKey, display)
  )
}
