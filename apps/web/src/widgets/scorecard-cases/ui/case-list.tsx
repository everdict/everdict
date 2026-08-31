'use client'

import { memo, useCallback, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  CASE_GROUPINGS,
  CASE_ORDERS,
  caseVerdictKey,
  scorecardCaseListSpec,
  type CaseVerdictKey,
} from '@/entities/scorecard'
import {
  fmtMetricLabel,
  groupMetricRows,
  isUnmeasuredScore,
  scoreBadgeValue,
  scoreTone,
} from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import {
  facetOptionsOf,
  LIST_GROUP_ROW_HEIGHT_PX,
  ListGroupRow,
  ListToolbar,
  type FacetSpec,
} from '@/shared/ui/list-toolbar'
import { VirtualList } from '@/shared/ui/virtual-list'

import type { ScorecardCaseView } from '../model/case-view'
import { useScorecardCases } from './case-dialog-context'

// The case explorer — one case reads as ONE fixed-height line, with the list toolbar (search · filter ·
// display) above it.
//
// This screen was redrawn because of batches of hundreds. Before, each case was a card, all of them stood at
// once, and the filter was a link that re-rendered the whole route: 500 cases meant thousands of nodes, and
// pressing "failed only" ran a server render that re-read the scorecard, the dataset, the child runs and the
// runner roster. Three things changed:
//  ① the window (VirtualList) — only the rows crossing the screen are drawn, so the DOM tracks the viewport
//     rather than the case count.
//  ② the list grammar (ListToolbar) — filtering, grouping and ordering happen in the browser, zero round
//     trips; the collection is already in hand.
//  ③ the weight — the evidence (task body, score detail, full error text, screenshot) does not ride a row.
//     The dialog fetches the one case it opened.
// The principle that everything else belongs to the dialog you click into is unchanged.

// Row height is **fixed**: the window computes its spacers from this number, so a single row that grows by
// wrapping desyncs the scroll. That is why the badges stop at a few and the rest folds into +N — all of them
// are in the dialog anyway.
const ROW_HEIGHT_PX = 40
const MAX_ROW_BADGES = 2
// The window's max height. Shorter content stands at its own height with no scrollbar, so a batch of a few
// cases looks exactly as it did before.
const VIEWPORT_MAX_HEIGHT = 'min(70vh, 780px)'

type CaseRow =
  | {
      kind: 'group'
      key: string
      groupKey: string
      label: string
      count: number
      collapsed: boolean
    }
  | { kind: 'case'; key: string; item: ScorecardCaseView }

export function ScorecardCaseList() {
  const { all, groups, visible, view, activeKey, openCase } = useScorecardCases()
  const t = useTranslations('scorecardsPage')
  const list = useTranslations('listView')

  const verdictLabel = useCallback(
    (key: string): string =>
      key === 'fail'
        ? t('caseVerdictFail')
        : key === 'skip'
          ? t('caseVerdictSkip')
          : t('caseVerdictPass'),
    [t]
  )

  const facets = useMemo((): FacetSpec[] => {
    const of = (facet: string, labelOf: (value: string) => string, unset?: string): FacetSpec => ({
      key: facet,
      label: list(`facet.${facet}`),
      options: facetOptionsOf(
        all,
        (c) => scorecardCaseListSpec.facetValues(c, facet),
        labelOf,
        unset
      ),
    })
    return [
      of('verdict', verdictLabel),
      // "What knocked it down" only has values on failed cases — on an all-passing batch the axis disappears.
      of('failedBy', (value) => value),
      of('tag', (value) => value),
      of('env', (value) => value, list('unset.env')),
    ].filter((facet) => facet.options.length > 0)
  }, [all, list, verdictLabel])

  // Collapsed groups — folding "470 passed" away is the thing people do most in front of hundreds of rows.
  // It is a momentary state of the reader, so it goes into neither the cookie nor the URL: unlike a display
  // preference, it is not something to remember until the next visit.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const grouped = view.display.grouping !== 'none'
  const rows = useMemo((): CaseRow[] => {
    const out: CaseRow[] = []
    for (const group of groups) {
      const groupKey = group.key ?? ''
      if (grouped) {
        const isCollapsed = collapsed.has(groupKey)
        out.push({
          kind: 'group',
          key: `group:${groupKey}`,
          groupKey,
          // Grouped by verdict the key is never empty — caseVerdictKey always answers one of three. If it
          // somehow were, it would mean "no verdict", which IS skip (no invented label goes up).
          label: group.key === null ? t('caseVerdictSkip') : verdictLabel(group.key),
          count: group.items.length,
          collapsed: isCollapsed,
        })
        if (isCollapsed) continue
      }
      for (const item of group.items) out.push({ kind: 'case', key: item.key, item })
    }
    return out
  }, [groups, grouped, collapsed, list, verdictLabel, view.display.grouping])

  // Back to the top when the contents change — a filter applied while you were at row 500 leaves that
  // position pointing at nothing.
  const resetKey = `${JSON.stringify(view.filters)}|${view.search}|${view.display.grouping}|${view.display.order}`

  const heightOf = useCallback(
    (row: CaseRow) => (row.kind === 'group' ? LIST_GROUP_ROW_HEIGHT_PX : ROW_HEIGHT_PX),
    []
  )
  const keyOf = useCallback((row: CaseRow) => row.key, [])

  return (
    <div className="space-y-2.5">
      <ListToolbar
        search={view.search}
        onSearch={view.setSearch}
        facets={facets}
        filters={view.filters}
        onToggleFilter={view.toggleFilter}
        onClearFilters={view.clearFilters}
        total={visible.length}
        groupings={CASE_GROUPINGS}
        orders={CASE_ORDERS}
        display={view.display}
        onDisplay={view.setDisplay}
      />
      {visible.length === 0 ? (
        <EmptyState title={list('emptyFilteredTitle')} hint={list('emptyFilteredHint')} />
      ) : (
        <VirtualList
          items={rows}
          keyOf={keyOf}
          heightOf={heightOf}
          maxHeight={VIEWPORT_MAX_HEIGHT}
          resetKey={resetKey}
          className="overflow-y-auto rounded-lg border border-border bg-card"
        >
          {(row) =>
            row.kind === 'group' ? (
              <ListGroupRow
                label={row.label}
                count={row.count}
                collapsed={row.collapsed}
                onToggle={() => toggleGroup(row.groupKey)}
                className="border-b border-border bg-elevated/60 px-2.5"
              />
            ) : (
              <CaseListRow
                item={row.item}
                active={row.item.key === activeKey}
                onOpen={openCase}
                verdictLabel={verdictLabel}
              />
            )
          }
        </VirtualList>
      )}
    </div>
  )
}

// One case = one line. Memoized because every ←/→ step through the open dialog re-renders this list, while
// the only rows that actually differ are the two the highlight moved between.
const CaseListRow = memo(function CaseListRow({
  item,
  active,
  onOpen,
  verdictLabel,
}: {
  item: ScorecardCaseView
  active: boolean
  // Takes a STABLE function — a closure built per row would break the memo on every render.
  onOpen: (key: string) => void
  verdictLabel: (key: CaseVerdictKey) => string
}) {
  const t = useTranslations('scorecardsPage')
  const caseMetrics = item.scores.map((s) => s.metric)
  // Criteria belong to the dialog — a row stands only the overall (group head) badges, and only a few.
  const overall = groupMetricRows(item.scores).map((g) => g.row)
  const shown = overall.slice(0, MAX_ROW_BADGES)
  const verdict = caseVerdictKey(item.verdict)
  // On a failed case "how it died" comes before "what it was" — there is one line, so it carries that one.
  const line = item.errorSummary ?? item.taskSummary

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(item.key)
        }
      }}
      style={{ height: ROW_HEIGHT_PX }}
      className={cn(
        'flex cursor-pointer items-center gap-2.5 border-b border-border/60 px-2.5 transition-colors hover:bg-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
        active && 'bg-accent/70'
      )}
    >
      <Badge
        tone={verdict === 'fail' ? 'danger' : verdict === 'skip' ? 'neutral' : 'success'}
        title={verdictLabel(verdict)}
      >
        {verdict === 'fail' ? 'FAIL' : verdict === 'skip' ? 'SKIP' : 'PASS'}
      </Badge>
      <span className="shrink-0 truncate font-mono text-[12.5px] font-[510]">{item.caseId}</span>
      {/* A trialled batch — without which run of the same case this is, the rows read as identical twins. */}
      {item.trial !== undefined && (
        <span className="shrink-0 font-mono text-[11px] text-faint">
          {t('caseTrialBadge', { n: item.trial })}
        </span>
      )}
      {/* One line of what the case was (or what killed it) — so the list itself already says which case
          this is. */}
      {line !== undefined && (
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12px]',
            item.errorSummary !== undefined ? 'text-destructive/80' : 'text-muted-foreground'
          )}
          title={line}
        >
          {line}
        </span>
      )}
      {line === undefined && <span className="min-w-0 flex-1" />}
      {/* In a narrow column (the infra panel open) the score badges drop out — omitted, never wrapped: under
          the window's fixed-height rule a wrap desyncs the scroll, and the full values belong to the dialog
          anyway. */}
      <span className="hidden shrink-0 items-center gap-1.5 @2xl:flex">
        {item.scores.length === 0 ? (
          <span className="text-[11.5px] text-faint">{t('noScores')}</span>
        ) : (
          <>
            {shown.map((s) => (
              <Badge key={`${s.graderId}:${s.metric}`} title={s.metric} tone={scoreTone(s)}>
                {fmtMetricLabel(s.metric, caseMetrics)}{' '}
                {isUnmeasuredScore(s) ? t('scoreUnmeasured') : scoreBadgeValue(s)}
              </Badge>
            ))}
            {overall.length > shown.length && (
              <span className="text-[11px] tabular-nums text-faint">
                +{overall.length - shown.length}
              </span>
            )}
          </>
        )}
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-faint" />
    </div>
  )
})
