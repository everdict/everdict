'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  listViewQuery,
  saveListDisplay,
  toggleListFilter,
  type ListDisplay,
  type ListFilters,
} from './list-view'

// The browser holds a list screen's view state — that is the whole of "instant".
//
// It used to be `router.push` for a filter and a server action plus `router.refresh()` for a grouping change.
// Both re-render the whole route, so the screen emptied into a skeleton once and every read unrelated to this list ran again with it.
// On a screen that already holds the collection, that round trip is pure overhead.
//
// So the state lives here and the address **follows**: `history.replaceState` updates the address bar without causing a Next server render,
// so the property of being a pasteable link survives intact. Display settings are written straight to the cookie (so the server draws the
// first screen with them on the next visit). `replace` rather than `push` because nobody wants to retrace six steps after touching filters
// six times and pressing back.
export interface ListViewControls {
  filters: ListFilters
  search: string
  display: ListDisplay
  toggleFilter: (facet: string, value: string) => void
  clearFilters: () => void
  setSearch: (value: string) => void
  setDisplay: (next: Partial<ListDisplay>) => void
}

// How long the search term waits before it is written to the address. The FILTERING happens as you type; only the address is late.
const SEARCH_URL_DELAY_MS = 300

export function useListView(input: {
  // This list's address — the path with no query. The filters attach to it.
  basePath: string
  // The key the display settings are remembered under (one per screen).
  viewKey: string
  // The filter axes this list knows — also the order they are written to the address in.
  facets: readonly string[]
  initialFilters: ListFilters
  initialSearch: string
  initialDisplay: ListDisplay
  // Params that are NOT this list's axes but must survive in the address. They are copied from the address
  // bar AT WRITE TIME, because they are not part of the list's state. The scorecard detail's case list is
  // such a screen: an open case dialog lives at the same address as `?case=`, so a rebuilt query string
  // would delete that shareable link the moment anyone touched a filter.
  preserve?: readonly string[]
}): ListViewControls {
  const { basePath, viewKey, facets, initialFilters, initialSearch, initialDisplay, preserve } =
    input
  const [filters, setFilters] = useState<ListFilters>(initialFilters)
  const [search, setSearchValue] = useState(initialSearch)
  const [display, setDisplayValue] = useState<ListDisplay>(initialDisplay)

  // So the timer and the handlers can read the newest values — an address write must always write "the screen right now", and a state update
  // is asynchronous, so a value just created cannot be read back. It is not computed inside the updater function because that has to stay
  // pure (StrictMode calls it twice).
  const latest = useRef({ filters, search, display })
  latest.current = { filters, search, display }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const writeUrl = useCallback(() => {
    const query = listViewQuery(latest.current.filters, facets, latest.current.search)
    if (preserve !== undefined && preserve.length > 0) {
      const current = new URLSearchParams(window.location.search)
      for (const name of preserve) {
        for (const value of current.getAll(name)) query.append(name, value)
      }
    }
    const qs = query.toString()
    window.history.replaceState(null, '', qs === '' ? basePath : `${basePath}?${qs}`)
  }, [basePath, facets, preserve])

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
      // The cookie is for the NEXT visit only — the current screen has already changed.
      saveListDisplay(viewKey, merged)
    },
    [viewKey]
  )

  // The returned object's identity is pinned: one screen hands this down through context (the scorecard
  // detail's case explorer), and a fresh object per render would re-render the list reading that context on
  // every unrelated state change — a dialog opening, for instance.
  return useMemo(
    () => ({ filters, search, display, toggleFilter, clearFilters, setSearch, setDisplay }),
    [filters, search, display, toggleFilter, clearFilters, setSearch, setDisplay]
  )
}
