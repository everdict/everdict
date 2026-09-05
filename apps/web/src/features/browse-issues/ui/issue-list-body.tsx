'use client'

import { useCallback, useRef, useState } from 'react'
import { CircleDot } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  ISSUE_FILTER_FACETS,
  issueViewHref,
  normalizeIssueDisplay,
  saveIssueDisplay,
  toggleIssueFilter,
  type IssueSummary,
  type IssueView,
} from '@/entities/issue'
import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'

import type { IssueViewBase, IssueViewData } from '../api/issue-view-data'
import { loadIssueViewAction } from '../api/load-issue-view'
import { loadIssuePageAction } from '../api/load-issues'
import type { IssueDirectories } from '../model/directories'
import { IssueBoard, type IssueBoardColumn } from './issue-board'
import { IssueDisplayMenu } from './issue-display-menu'
import { IssueFilterMenu } from './issue-filter-menu'
import { IssueGroup } from './issue-group'
import { IssueRow } from './issue-row'

// The body of the issue list — the toolbar and the rows. That the VIEW (filters and display) is held **here** is the heart of this screen.
//
// It used to be `router.push` for a filter and a server action plus `router.refresh()` for a grouping change. Both re-render the whole
// route, so the screen emptied into a skeleton and every read unrelated to the list (members, projects, labels, the cycle roster, GitHub
// App state) ran again each time. Now only the list changes, and **the previous list stays on screen** until the new one arrives —
// exactly as Linear does.
//
// The address FOLLOWS: only the filters are written, with `history.replaceState` (the door that causes no server render). So the property of
// being a pasteable link is unchanged, and the display settings still never ride in the address — a link you send must not rearrange the
// recipient's screen.
export function IssueListBody({
  workspace,
  basePath,
  viewKey,
  base,
  initialView,
  initialData,
  directories,
  projects,
  canWrite,
  timeZone,
}: {
  workspace: string
  basePath: string
  viewKey: string
  // The narrowing the address decides (team, triage, cycle) — unchanged when the view changes.
  base: IssueViewBase
  initialView: IssueView
  initialData: IssueViewData
  directories: IssueDirectories
  projects: { id: string; name: string }[]
  canWrite: boolean
  timeZone: string
  // The team chips on the workspace-wide list — drawn and passed by the server (unrelated to the view, and only links).
  // The bulk edit bar — only on a screen with something to select.
}) {
  const t = useTranslations('issuesPage')
  const [view, setView] = useState(initialView)
  const [data, setData] = useState(initialData)
  const [pending, setPending] = useState(false)
  // So a late response cannot overwrite a newer screen — two quick interactions can otherwise land out of order.
  const sequence = useRef(0)

  const apply = useCallback(
    (next: IssueView) => {
      const merged: IssueView = { ...normalizeIssueDisplay(next), filters: next.filters }
      setView(merged)
      // Filters into the address only, display settings into the cookie only. Neither costs a server round trip.
      window.history.replaceState(null, '', issueViewHref(basePath, merged))
      saveIssueDisplay(viewKey, merged)
      const seq = sequence.current + 1
      sequence.current = seq
      setPending(true)
      void loadIssueViewAction({ base, view: merged })
        .then((fresh) => {
          if (sequence.current !== seq) return
          setData(fresh)
          setPending(false)
        })
        .catch((e: unknown) => {
          if (sequence.current !== seq) return
          setData({
            groups: [],
            droppedGroups: 0,
            error: { kind: 'load', message: e instanceof Error ? e.message : String(e) },
          })
          setPending(false)
        })
    },
    [base, basePath, viewKey]
  )

  const error =
    data.error === undefined
      ? undefined
      : data.error.kind === 'counts'
        ? t('countsUnavailable')
        : t('loadError', { error: data.error.message })

  const empty =
    view.grouping === 'none'
      ? (data.flat?.items.length ?? 0) === 0
      : (data.total ?? 0) === 0 && data.error === undefined

  return (
    <>
      {/* The toolbar — WHAT to look at (filters) and HOW to look at it (display). */}
      <div className="flex flex-wrap items-center gap-2">
        <IssueFilterMenu
          filters={view.filters}
          directories={directories}
          projects={projects}
          onToggle={(facet, value) => {
            // The shared menu returns an axis as a string — narrowing it to an axis the issue knows happens here (rather than with an assertion).
            const known = ISSUE_FILTER_FACETS.find((candidate) => candidate === facet)
            if (known === undefined) return
            apply({ ...view, filters: toggleIssueFilter(view.filters, known, value) })
          }}
          onClear={() => apply({ ...view, filters: {} })}
        />
        <div className="ml-auto flex items-center gap-2">
          {data.total !== undefined && (
            <span className="text-[12px] tabular-nums text-muted-foreground">
              {t('totalCount', { count: data.total })}
            </span>
          )}
          <IssueDisplayMenu display={view} onChange={(next) => apply({ ...view, ...next })} />
        </div>
      </div>

      {/* The previous list stays standing while the new one is awaited — emptying into a skeleton removes what was just being read. */}
      <div
        aria-busy={pending}
        className={cn('transition-opacity duration-150', pending && 'opacity-55')}
      >
        {error ? (
          <Callout tone="danger">{error}</Callout>
        ) : empty ? (
          <EmptyState
            icon={<CircleDot strokeWidth={1.75} />}
            title={
              base.cycle !== undefined
                ? t('cycleEmptyTitle')
                : base.triage === true
                  ? t('triageEmptyTitle')
                  : t('emptyTitle')
            }
            hint={
              base.cycle !== undefined
                ? t('cycleEmptyHint')
                : base.triage === true
                  ? t('triageEmptyHint')
                  : t('emptyHint')
            }
          />
        ) : view.grouping === 'none' ? (
          <FlatIssues
            workspace={workspace}
            data={data}
            directories={directories}
            canWrite={canWrite}
            timeZone={timeZone}
          />
        ) : data.groupBy !== undefined && view.layout === 'board' ? (
          <IssueBoard
            workspace={workspace}
            groupBy={data.groupBy}
            columns={data.groups.map(
              (group): IssueBoardColumn => ({
                key: group.key,
                count: group.count,
                items: group.items,
                truncated: group.nextCursor !== undefined,
              })
            )}
            directories={directories}
            canWrite={canWrite}
          />
        ) : data.groupBy !== undefined ? (
          <div className="space-y-3">
            {data.groups.map((group) => (
              <IssueGroup
                key={group.key ?? 'unset'}
                workspace={workspace}
                groupBy={data.groupBy ?? 'status'}
                groupKey={group.key}
                count={group.count}
                initial={group.items}
                {...(group.nextCursor !== undefined ? { initialCursor: group.nextCursor } : {})}
                query={group.query}
                directories={directories}
                canWrite={canWrite}
                timeZone={timeZone}
              />
            ))}
          </div>
        ) : null}

        {/* A silent cap reads as "you have seen everything" — say how many groups were not stood up. */}
        {data.droppedGroups > 0 && (
          <p className="pt-3 text-[11.5px] text-muted-foreground">
            {t('groupsTruncated', { count: data.droppedGroups })}
          </p>
        )}
      </div>
    </>
  )
}

// One page of an ungrouped list plus the pages after it. This used to be a link carrying the cursor in the address, which made a single
// "show more" re-render the route and lose the place being read — it is appended the same way a group's "show more" is.
function FlatIssues({
  workspace,
  data,
  directories,
  canWrite,
  timeZone,
}: {
  workspace: string
  data: IssueViewData
  directories: IssueDirectories
  canWrite: boolean
  timeZone: string
}) {
  const t = useTranslations('issuesPage')
  const [items, setItems] = useState<IssueSummary[]>(data.flat?.items ?? [])
  const [cursor, setCursor] = useState(data.flat?.nextCursor)
  const [loading, setLoading] = useState(false)

  // The server's freshly drawn FIRST page is the truth — when the view changes, the extra rows loaded must disappear (they do not belong to that list).
  const [seen, setSeen] = useState(data.flat)
  if (seen !== data.flat) {
    setSeen(data.flat)
    setItems(data.flat?.items ?? [])
    setCursor(data.flat?.nextCursor)
  }

  function loadMore() {
    const query = data.flatQuery
    if (query === undefined || cursor === undefined || loading) return
    setLoading(true)
    void loadIssuePageAction({ ...query, cursor }).then((result) => {
      setLoading(false)
      if (!result.ok) return
      setItems((prev) => [...prev, ...result.page.items])
      setCursor(result.page.nextCursor)
    })
  }

  return (
    <div className="space-y-1.5">
      {items.map((issue) => (
        <IssueRow
          key={issue.id}
          workspace={workspace}
          issue={issue}
          directories={directories}
          canWrite={canWrite}
          timeZone={timeZone}
        />
      ))}
      {cursor !== undefined && (
        <div className="pt-1">
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-60"
          >
            {t('loadMore')}
          </button>
        </div>
      )}
    </div>
  )
}
