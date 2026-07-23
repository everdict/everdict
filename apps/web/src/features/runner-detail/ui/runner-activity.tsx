'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Cpu, RefreshCw } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import type { Run } from '@/entities/run'
import { fmtTimeAgo } from '@/shared/lib/format'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { StatusPill } from '@/shared/ui/status-pill'

import { listRunnerRunsAction } from '../api/runner-detail'

const PAGE_SIZE = 10
// Keep the newest page fresh while the tab is open — one bounded page fetch, not the whole history (the perf win over
// the old server-side fetch that pulled every recent run on each 12s router.refresh).
const REFRESH_MS = 12_000

// The runner's recent runs (provenance) as an offset-paginated activity feed. Each page fetches exactly PAGE_SIZE rows
// client-side, so the detail page's initial paint no longer blocks on a heavy runs read and the periodic refresh only
// re-pulls the newest page. Every row links straight to that run's detail screen.
export function RunnerActivity({ runnerId, workspace }: { runnerId: string; workspace: string }) {
  const t = useTranslations('runnerDetail')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const [page, setPage] = useState(0)
  const [runs, setRuns] = useState<Run[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  // Current page mirrored in a ref so the background refresh + stale-response guard read it without re-subscribing.
  const pageRef = useRef(page)
  pageRef.current = page

  const load = useCallback(
    async (target: number, opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      const r = await listRunnerRunsAction(runnerId, target, PAGE_SIZE)
      // Drop a response for a page the user has since left (Next clicked while a fetch was in flight).
      if (pageRef.current !== target) return
      if (r.ok) {
        setRuns(r.runs)
        setHasMore(r.hasMore)
        setError(undefined)
      } else {
        setError(r.error)
      }
      setLoading(false)
    },
    [runnerId]
  )

  // Fetch on mount and whenever the page changes.
  useEffect(() => {
    void load(page)
  }, [page, load])

  // Live-ish: quietly refresh the newest page while the tab is visible (no spinner reset, no page jump).
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && pageRef.current === 0) void load(0, { quiet: true })
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <p className="text-[13px] font-[560] text-foreground">{t('activityTitle')}</p>
        {loading && <RefreshCw className="size-3 animate-spin text-faint" />}
      </div>

      {error ? (
        <p className="text-[13px] text-destructive">{error}</p>
      ) : runs.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {loading ? t('activityLoading') : t('activityEmpty')}
        </p>
      ) : (
        <Card className="divide-y divide-border">
          {runs.map((r) => (
            <Link
              key={r.id}
              href={`/${workspace}/runs/${encodeURIComponent(r.id)}`}
              className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elevated"
            >
              <Cpu className="size-3.5 shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{r.caseId}</span>
              <span className="hidden shrink-0 text-[12px] text-muted-foreground sm:inline">
                {r.harness.id}@{r.harness.version}
              </span>
              <span className="w-[92px] shrink-0 text-right text-[11px] text-faint">
                {fmtTimeAgo(r.createdAt, locale, timeZone)}
              </span>
              <StatusPill status={r.status} />
              {/* Affordance that the whole row navigates to this run's detail screen. */}
              <ChevronRight className="size-3.5 shrink-0 text-faint" />
            </Link>
          ))}
        </Card>
      )}

      {/* Prev/Next — shown once there's more than the first page. */}
      {(page > 0 || hasMore) && (
        <div className="flex items-center justify-between pt-0.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="size-3.5" />
            {t('paginationPrev')}
          </Button>
          <span className="text-[12px] text-muted-foreground">
            {t('paginationPage', { page: page + 1 })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!hasMore || loading}
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
