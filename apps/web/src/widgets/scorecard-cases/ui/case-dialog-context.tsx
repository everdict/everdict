'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

import { CASE_FACETS, scorecardCaseListSpec } from '@/entities/scorecard'
import { applyListView, type ListGroup } from '@/shared/lib/list-view'
import type { ListViewScope } from '@/shared/lib/load-list-view'
import { useListView, type ListViewControls } from '@/shared/lib/use-list-view'

import type { ScorecardCaseView } from '../model/case-view'
import { CaseDetailDialog } from './case-detail-dialog'

// One place holds the case explorer's state — the view (search · filter · grouping · ordering) and the case
// that is open.
//
// Why those two live together: the dialog's ←/→ must walk **the order on screen**. With a filter on, that
// order is the list's own, not the original the server sent, and computing it in two places would let the
// next case the list shows and the next case the arrow opens drift apart.
//
// A case has more than one door — the case row, the case step in the progress timeline. Those scattered
// sections share one dialog through this context. The open state is mirrored into the URL as ?case=
// (the shared-dialog convention — docs/web.md), so the current address IS this case's shareable link.
// replaceState (a null state is required: Next's __NA marker breaks the router's canonical-URL sync and the
// next server action then restores the old address), no route re-render — the filters follow the same rule.
type ScorecardCasesContextValue = {
  // Everything the server sent — where the axes count their options (only values present are offered) and
  // where a deep link finds a case that the current filter excludes.
  all: ScorecardCaseView[]
  // What stands on screen: the groups as drawn, and those groups flattened (the order the dialog's sibling
  // navigation walks).
  groups: ListGroup<ScorecardCaseView>[]
  visible: ScorecardCaseView[]
  view: ListViewControls
  activeKey: string | undefined
  // Opened by the row's unique key — a trialled batch repeats one caseId across rows, so the key is the
  // unit of selection.
  openCase: (key: string) => void
}

const ScorecardCasesContext = createContext<ScorecardCasesContextValue | null>(null)

// Not one of this list's axes, but it has to survive in the address: the open case. A module constant
// because its identity must be stable, or the view hook's callbacks are rebuilt on every render.
const PRESERVED_PARAMS = ['case'] as const

export function useScorecardCases(): ScorecardCasesContextValue {
  const ctx = useContext(ScorecardCasesContext)
  if (!ctx) throw new Error('useScorecardCases must be used within ScorecardCasesProvider')
  return ctx
}

// Writes the open state into the URL, or clears it — leaving the case filters alone (the view hook rewrites
// only its own axes and carries `case` across through `preserve`).
function mirrorCaseParam(key: string | undefined) {
  const url = new URL(window.location.href)
  if (key !== undefined) url.searchParams.set('case', key)
  else url.searchParams.delete('case')
  window.history.replaceState(null, '', url.pathname + url.search + url.hash)
}

export function ScorecardCasesProvider({
  workspace,
  scorecardId,
  cases,
  initialCaseId,
  scope,
  children,
}: {
  workspace: string
  scorecardId: string
  cases: ScorecardCaseView[]
  // The case a deep link (?case=) arrived on — the page reads searchParams and passes it. Ignored when the
  // list does not hold it.
  initialCaseId: string | undefined
  // This list's view state as the server read it — filters from the address, grouping/ordering from the
  // reader's cookie.
  scope: ListViewScope
  children: ReactNode
}) {
  const view = useListView({
    basePath: scope.basePath,
    viewKey: scope.viewKey,
    facets: CASE_FACETS,
    initialFilters: scope.filters,
    initialSearch: scope.search,
    initialDisplay: scope.display,
    preserve: PRESERVED_PARAMS,
  })

  // Filtering, grouping and ordering all happen in the browser — one batch's cases are already in hand, so a
  // filter costs zero round trips (the old all/failed tabs were links, and every click re-rendered this
  // whole route).
  const { groups } = useMemo(
    () =>
      applyListView<ScorecardCaseView>(
        cases,
        { filters: view.filters, search: view.search, display: view.display },
        scorecardCaseListSpec
      ),
    [cases, view.filters, view.search, view.display]
  )
  const visible = useMemo(() => groups.flatMap((group) => group.items), [groups])

  // A deep link matches the row key exactly first, otherwise it opens that caseId's first row (older links
  // carry no trial number).
  const [activeKey, setActiveKey] = useState<string | undefined>(() => {
    if (initialCaseId === undefined) return undefined
    const exact = cases.find((c) => c.key === initialCaseId)
    return (exact ?? cases.find((c) => c.caseId === initialCaseId))?.key
  })

  const openCase = useCallback((key: string) => {
    setActiveKey(key)
    mirrorCaseParam(key)
  }, [])
  const close = useCallback(() => {
    setActiveKey(undefined)
    mirrorCaseParam(undefined)
  }, [])

  const value = useMemo(
    () => ({ all: cases, groups, visible, view, activeKey, openCase }),
    [cases, groups, visible, view, activeKey, openCase]
  )

  // Sibling navigation walks the order on screen. A case opened from the timeline while the filter excludes
  // it has no place in that order (index = -1), so the dialog opens without the navigation control — "1 / 500"
  // would be a lie.
  const index = visible.findIndex((c) => c.key === activeKey)
  const active = index >= 0 ? visible[index] : cases.find((c) => c.key === activeKey)

  return (
    <ScorecardCasesContext.Provider value={value}>
      {children}
      {active && (
        <CaseDetailDialog
          workspace={workspace}
          scorecardId={scorecardId}
          item={active}
          onClose={close}
          nav={{
            index,
            total: visible.length,
            onPrev: () => {
              const prev = visible[index - 1]
              if (prev) openCase(prev.key)
            },
            onNext: () => {
              const next = visible[index + 1]
              if (next) openCase(next.key)
            },
          }}
        />
      )}
    </ScorecardCasesContext.Provider>
  )
}

// The small door standing on a case step in the progress timeline — an inline chip in the same grammar as
// the "→ run" link. The server stands it only on a step whose case HAS a result (a step without one keeps
// the → run link as its only door).
export function OpenCaseChip({ caseId }: { caseId: string }) {
  const ctx = useContext(ScorecardCasesContext)
  // A timeline step knows only the caseId, so on a trialled batch it opens that case's first row (the dialog
  // walks the siblings from there).
  const first = ctx?.all.find((c) => c.caseId === caseId)
  if (!ctx || !first) return null
  return (
    <button
      type="button"
      onClick={() => ctx.openCase(first.key)}
      className="ml-2 rounded-sm font-mono text-[11px] text-link transition-colors hover:text-foreground"
    >
      → case
    </button>
  )
}
