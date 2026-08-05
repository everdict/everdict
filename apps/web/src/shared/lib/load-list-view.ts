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

// 목록 화면 하나가 서버에서 조립되는 방식 — 네 평가 자원 목록이 똑같이 하는 일이라 한 곳에 둔다.
//
// 필터는 주소에서, 표시 설정은 읽는 사람의 쿠키에서. 쿠키를 서버에서 읽는 것이 요점이다: 그래야 첫 페인트가
// 이미 그 사람이 고른 묶기로 그려지고, 나중에 클라이언트가 고쳐 그리는 깜빡임이 없다.
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
