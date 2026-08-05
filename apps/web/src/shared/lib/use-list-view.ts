'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  listViewQuery,
  saveListDisplay,
  toggleListFilter,
  type ListDisplay,
  type ListFilters,
} from './list-view'

// 목록 화면의 보기 상태를 브라우저가 든다 — 그게 "즉각적"의 전부다.
//
// 예전에는 필터를 켜면 `router.push` 가, 묶는 기준을 바꾸면 서버 액션 + `router.refresh()` 가 일어났다.
// 둘 다 라우트 전체를 다시 그리는 일이라, 화면이 스켈레톤으로 한 번 비워지고 이 목록과 아무 상관 없는
// 읽기들까지 같이 다시 돌았다. 컬렉션이 이미 손에 있는 화면에서는 그 왕복이 통째로 군더더기다.
//
// 그래서 상태는 여기 있고, 주소는 **뒤따라온다**: `history.replaceState` 는 Next 의 서버 렌더를 일으키지
// 않으면서 주소창만 갱신하므로, 붙여넣을 수 있는 링크라는 성질은 그대로 남는다. 표시 설정은 쿠키에 바로
// 적는다(다음 방문에 서버가 첫 화면을 그 설정으로 그리라고). `replace` 이지 `push` 가 아닌 이유: 필터를
// 여섯 번 만지고 뒤로 가기를 눌렀을 때 여섯 번을 되짚는 것은 아무도 원하지 않는다.
export interface ListViewControls {
  filters: ListFilters
  search: string
  display: ListDisplay
  toggleFilter: (facet: string, value: string) => void
  clearFilters: () => void
  setSearch: (value: string) => void
  setDisplay: (next: Partial<ListDisplay>) => void
}

// 검색어가 주소에 적히기까지 기다리는 시간. 거르는 일 자체는 타이핑과 동시에 일어나고, 늦는 것은 주소뿐이다.
const SEARCH_URL_DELAY_MS = 300

export function useListView(input: {
  // 이 목록의 주소 — 쿼리 없는 경로. 여기에 필터가 붙는다.
  basePath: string
  // 표시 설정을 기억할 키(화면마다 하나).
  viewKey: string
  // 이 목록이 아는 필터 축들 — 주소에 적히는 순서이기도 하다.
  facets: readonly string[]
  initialFilters: ListFilters
  initialSearch: string
  initialDisplay: ListDisplay
}): ListViewControls {
  const { basePath, viewKey, facets, initialFilters, initialSearch, initialDisplay } = input
  const [filters, setFilters] = useState<ListFilters>(initialFilters)
  const [search, setSearchValue] = useState(initialSearch)
  const [display, setDisplayValue] = useState<ListDisplay>(initialDisplay)

  // 최신 값을 타이머와 핸들러가 읽을 수 있게 — 주소 쓰기는 항상 "지금 화면"을 적어야 하고, 상태 갱신은
  // 비동기라 방금 만든 값을 다시 읽을 수 없다. 갱신 함수 안에서 계산하지 않는 이유는 그것이 순수해야 하기
  // 때문이다(StrictMode 는 두 번 부른다).
  const latest = useRef({ filters, search, display })
  latest.current = { filters, search, display }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const writeUrl = useCallback(() => {
    const qs = listViewQuery(latest.current.filters, facets, latest.current.search).toString()
    window.history.replaceState(null, '', qs === '' ? basePath : `${basePath}?${qs}`)
  }, [basePath, facets])

  useEffect(() => () => clearTimeout(timer.current), [])

  const toggleFilter = useCallback(
    (facet: string, value: string) => {
      const next = toggleListFilter(latest.current.filters, facet, value)
      latest.current = { ...latest.current, filters: next }
      setFilters(next)
      writeUrl()
    },
    [writeUrl]
  )

  const clearFilters = useCallback(() => {
    setFilters({})
    latest.current = { ...latest.current, filters: {} }
    writeUrl()
  }, [writeUrl])

  const setSearch = useCallback(
    (value: string) => {
      setSearchValue(value)
      latest.current = { ...latest.current, search: value }
      clearTimeout(timer.current)
      timer.current = setTimeout(writeUrl, SEARCH_URL_DELAY_MS)
    },
    [writeUrl]
  )

  const setDisplay = useCallback(
    (next: Partial<ListDisplay>) => {
      const merged = { ...latest.current.display, ...next }
      latest.current = { ...latest.current, display: merged }
      setDisplayValue(merged)
      // 쿠키는 다음 방문을 위해서만 — 지금 화면은 이미 바뀌었다.
      saveListDisplay(viewKey, merged)
    },
    [viewKey]
  )

  return { filters, search, display, toggleFilter, clearFilters, setSearch, setDisplay }
}
