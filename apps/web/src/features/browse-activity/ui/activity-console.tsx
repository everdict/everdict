'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronLeft, ChevronRight, Layers, RefreshCw } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import { RunRow, type RunRowData } from '@/entities/run'
import { fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TH, THead, TR } from '@/shared/ui/table'

import {
  listActivityAction,
  listBatchCasesAction,
  type ActivityBlock,
} from '../api/browse-activity'

const PAGE_SIZE = 20
// Keep the newest page fresh while the tab is open — one lightweight feed fetch (no child runs), not the old flood.
const REFRESH_MS = 12_000

type CaseState = RunRowData[] | 'loading' | 'error'

// The "all executions" console: standalone runs + scorecard batches as one recency-ordered feed, paginated at the
// top-level-block granularity so a batch's cases never split across pages. A batch is a single collapsed summary row;
// its cases load on demand when expanded — so opening the page no longer pulls every case in the workspace at once.
export function ActivityConsole({ workspace }: { workspace: string }) {
  const t = useTranslations('activityConsole')
  const tr = useTranslations('runsTable')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const [blocks, setBlocks] = useState<ActivityBlock[]>([])
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cases, setCases] = useState<Record<string, CaseState>>({})

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true)
    const r = await listActivityAction()
    if (r.ok) {
      setBlocks(r.blocks)
      setError(undefined)
    } else {
      setError(r.error)
    }
    setLoading(false)
  }, [])

  // Fetch on mount.
  useEffect(() => {
    void load()
  }, [load])

  // Live-ish: quietly refresh the feed while visible and on the newest page (no spinner, no page jump).
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && page === 0) void load({ quiet: true })
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [load, page])

  // Expand/collapse a batch; on first expand, lazy-load its cases (cached thereafter).
  const toggle = useCallback((scorecardId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(scorecardId)) next.delete(scorecardId)
      else next.add(scorecardId)
      return next
    })
    setCases((prev) => {
      if (prev[scorecardId] && prev[scorecardId] !== 'error') return prev // already loaded / loading
      void listBatchCasesAction(scorecardId).then((r) =>
        setCases((c) => ({ ...c, [scorecardId]: r.ok ? r.runs : 'error' }))
      )
      return { ...prev, [scorecardId]: 'loading' }
    })
  }, [])

  if (error) return <Callout tone="danger">{t('loadError', { error })}</Callout>
  if (loading && blocks.length === 0) {
    return <p className="text-[13px] text-muted-foreground">{t('loading')}</p>
  }
  if (blocks.length === 0) {
    return <EmptyState title={tr('emptyTitle')} hint={tr('emptyHint')} />
  }

  const pageBlocks = blocks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const hasMore = blocks.length > (page + 1) * PAGE_SIZE
  const pageCount = Math.ceil(blocks.length / PAGE_SIZE)

  return (
    <div className="space-y-3">
      {loading && (
        <RefreshCw className="size-3 animate-spin text-faint" aria-label={t('loading')} />
      )}
      <Table>
        <THead>
          <tr>
            <TH className="w-[120px]">{tr('colRun')}</TH>
            <TH>{tr('colHarness')}</TH>
            <TH>{tr('colSource')}</TH>
            <TH>{tr('colStatus')}</TH>
            <TH className="text-right">{tr('colCost')}</TH>
            <TH className="text-right">{tr('colUpdated')}</TH>
          </tr>
        </THead>
        <TBody>
          {pageBlocks.map((block) =>
            block.kind === 'run' ? (
              <RunRow key={block.run.id} run={block.run} workspace={workspace} />
            ) : (
              <Fragment key={block.batch.id}>
                <TR
                  className="cursor-pointer bg-muted/40 hover:bg-muted/60"
                  onClick={() => toggle(block.batch.id)}
                >
                  <td colSpan={6} className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <ChevronDown
                        className={cn(
                          'size-3.5 text-muted-foreground transition-transform',
                          !expanded.has(block.batch.id) && '-rotate-90'
                        )}
                      />
                      <Layers className="size-3.5 text-muted-foreground" />
                      <span className="text-[12px] font-[510] text-muted-foreground">
                        {tr('batchGroup')}
                      </span>
                      <Link
                        href={`/${workspace}/scorecards/${block.batch.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-mono text-[12px] text-link transition-colors hover:text-foreground"
                      >
                        {block.batch.id.slice(0, 8)}
                      </Link>
                      <span className="font-[510]">{block.batch.harness.id}</span>
                      {block.batch.count !== undefined && (
                        <Badge tone="outline">{tr('batchCount', { n: block.batch.count })}</Badge>
                      )}
                      <StatusPill status={block.batch.status} />
                      <span className="ml-auto text-[12px] text-muted-foreground">
                        {fmtTimeAgo(block.batch.updatedAt, locale, timeZone)}
                      </span>
                    </div>
                  </td>
                </TR>
                {expanded.has(block.batch.id) &&
                  renderCases(cases[block.batch.id], block.batch.id, workspace, t)}
              </Fragment>
            )
          )}
        </TBody>
      </Table>

      {/* Prev/Next — shown once the feed spans more than one page. */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between pt-0.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="size-3.5" />
            {t('paginationPrev')}
          </Button>
          <span className="text-[12px] text-muted-foreground">
            {t('paginationPage', { page: page + 1, total: pageCount })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('paginationNext')}
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

// A batch's expanded cases — the lazy-loaded child rows, or a loading/error line spanning the table.
function renderCases(
  state: CaseState | undefined,
  scorecardId: string,
  workspace: string,
  t: ReturnType<typeof useTranslations<'activityConsole'>>
) {
  if (state === undefined || state === 'loading') {
    return (
      <TR>
        <td colSpan={6} className="px-3 py-2 pl-7 text-[12px] text-muted-foreground">
          <RefreshCw className="mr-1.5 inline size-3 animate-spin" />
          {t('casesLoading')}
        </td>
      </TR>
    )
  }
  if (state === 'error') {
    return (
      <TR>
        <td colSpan={6} className="px-3 py-2 pl-7 text-[12px] text-destructive">
          {t('casesError')}
        </td>
      </TR>
    )
  }
  return state.map((run) => <RunRow key={run.id} run={run} workspace={workspace} isChild />)
}
