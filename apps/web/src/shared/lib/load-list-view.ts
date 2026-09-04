import 'server-only'

import { cookies } from 'next/headers'

import {
  LIST_DISPLAY_COOKIE,
  listDisplayFor,
  listFiltersOf,
  type ListDisplay,
  type ListDisplayVocabulary,
  type ListFilters,
} from './list-view'

// How one list screen is assembled on the server — the four evaluation resource lists do exactly this, so it lives in one place.
//
// The filters come from the address and the display settings from the READER's cookie. Reading the cookie ON THE SERVER is the point: it makes
// the first paint already use that person's chosen grouping, with no flicker from the client correcting it afterwards.
export interface ListViewScope {
  basePath: string
  viewKey: string
  filters: ListFilters
  search: string
  display: ListDisplay
}

export async function loadListViewScope(input: {
  basePath: string
  viewKey: string
  facets: readonly string[]
  vocabulary: ListDisplayVocabulary
  params: Record<string, string | string[] | undefined>
}): Promise<ListViewScope> {
  const { basePath, viewKey, facets, vocabulary, params } = input
  const cookie = (await cookies()).get(LIST_DISPLAY_COOKIE)?.value
  return {
    basePath,
    viewKey,
    filters: listFiltersOf(params, facets),
    search: typeof params.q === 'string' ? params.q : '',
    display: listDisplayFor(cookie, viewKey, vocabulary),
  }
}
