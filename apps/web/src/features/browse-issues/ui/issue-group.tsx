'use client'

import { useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { IssueGroupBy, IssueSummary } from '@/entities/issue'
import { cn } from '@/shared/lib/utils'

import { loadIssuePageAction } from '../api/load-issues'
import type { IssueDirectories } from '../model/directories'
import type { IssuePageQuery } from '../model/page-query'
import { IssueGroupLabel } from './issue-group-label'
import { IssueRow } from './issue-row'

// One group — a collapsible header (the name plus the **real** count) with its rows beneath. The point is that the count comes from the SERVER
// aggregate: each group holds one page, so counting the received rows only restates the page size, and a screen saying "in progress 3" for
// something that is really 40 is worse than having no header at all.
//
// "Show more" is per group too (the same path as Linear) — only THIS group's rows are appended, so another group left expanded is undisturbed.
export function IssueGroup({
  workspace,
  groupBy,
  groupKey,
  count,
  initial,
  initialCursor,
  query,
  directories,
  canWrite,
  timeZone,
}: {
  workspace: string
  groupBy: IssueGroupBy
  groupKey: string | null
  count: number
  initial: IssueSummary[]
  initialCursor?: string
  // The query that fetches this group's next page — the same one the server used for the first.
  query: IssuePageQuery
  directories: IssueDirectories
  canWrite: boolean
  timeZone: string
}) {
  const t = useTranslations('issuesPage')
  const [collapsed, setCollapsed] = useState(false)
  const [items, setItems] = useState(initial)
  const [cursor, setCursor] = useState(initialCursor)
  const [pending, setPending] = useState(false)

  // The server's freshly drawn first page is the truth — when a status change makes `refresh()` run, this follows it. The extra loaded rows
  // disappear then: left standing after a filter change, rows that do not belong to the group would keep standing.
  const [seen, setSeen] = useState(initial)
  if (seen !== initial) {
    setSeen(initial)
    setItems(initial)
    setCursor(initialCursor)
  }

  function loadMore() {
    if (cursor === undefined) return
    void (async () => {
      setPending(true)
      try {
        const r = await loadIssuePageAction({ ...query, cursor })
        if (!r.ok) {
          toast.error(r.error)
          return
        }
        setItems((prev) => [...prev, ...r.page.items])
        setCursor(r.page.nextCursor)
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <section className="space-y-1">
      <div className="flex items-center gap-1.5 px-1 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-[12.5px] font-[510] text-foreground transition-colors hover:bg-accent"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-faint transition-transform',
              !collapsed && 'rotate-90'
            )}
            aria-hidden
          />
          <IssueGroupLabel groupBy={groupBy} groupKey={groupKey} directories={directories} />
        </button>
        <span className="shrink-0 rounded-full bg-secondary px-1.5 text-[11px] tabular-nums text-muted-foreground">
          {count}
        </span>
      </div>
      {!collapsed && (
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
            <button
              type="button"
              onClick={loadMore}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {pending && <Loader2 className="size-3 animate-spin" />}
              {/* It states how many REMAIN — a screen that knows the count saying only "show more" is hiding what it knows. */}
              {t('groupLoadMore', { count: Math.max(count - items.length, 0) })}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
