'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import { fmtDateTimeFull, fmtTimeAgo } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'

import { listTrajectoriesAction, type TrajectoryMeta } from '../api/browse-trajectories'
import { TrajectoryDetailDialog } from './trajectory-detail-dialog'

const PAGE_SIZE = 25

// The OWNED evidence ledger's browse list (native-observability N1 "look inward"): every sealed trajectory
// this workspace holds — our own executions, OTLP-door arrivals, materialized imports — newest first. A row
// opens the trajectory itself in a dialog (the ledger's own read), because only source "run" has a run
// record: an otlp arrival or a materialized import would dead-end on the run page. The dialog links out to
// the run when there IS one. Deliberately simpler than the platform TraceBrowser: no source axis, no scope
// — this is OUR store, one list.
export function TrajectoryBrowser() {
  const t = useTranslations('trajectoryBrowser')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const [openIndex, setOpenIndex] = useState<number | undefined>(undefined)
  const [items, setItems] = useState<TrajectoryMeta[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState(false)

  const load = useCallback((cursor?: string) => {
    void (async () => {
      setPending(true)
      try {
        const page = await listTrajectoriesAction({
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        })
        if (!page.ok) {
          setError(page.error)
          return
        }
        setError(undefined)
        setItems((prev) => (cursor ? [...prev, ...page.items] : page.items))
        setNextCursor(page.nextCursor)
        setLoaded(true)
      } finally {
        setPending(false)
      }
    })()
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (error) return <Callout tone="danger">{error}</Callout>
  if (loaded && items.length === 0) {
    return <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />
  }
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">{t('count', { count: items.length })}</div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {items.map((m, i) => (
          <li key={m.runId}>
            <button
              type="button"
              onClick={() => setOpenIndex(i)}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.runId}</span>
              <Badge tone="outline">{t(`source_${m.source}`)}</Badge>
              <span className="w-20 text-right text-xs text-muted-foreground">
                {t('events', { count: m.eventCount })}
              </span>
              <span
                className="w-28 text-right text-xs text-muted-foreground"
                title={fmtDateTimeFull(m.sealedAt, { locale, timeZone })}
              >
                {fmtTimeAgo(m.sealedAt, locale, timeZone)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {nextCursor ? (
        <Button variant="secondary" size="sm" onClick={() => load(nextCursor)} disabled={pending}>
          {t('loadMore')}
        </Button>
      ) : null}
      {/* prev/next 는 이미 불러온 페이지 안에서만 이동한다 — 다이얼로그가 커서를 더 당기지는 않는다. */}
      {openIndex !== undefined && items[openIndex] && (
        <TrajectoryDetailDialog
          open
          onClose={() => setOpenIndex(undefined)}
          meta={items[openIndex]}
          nav={{
            index: openIndex,
            total: items.length,
            onPrev: () => setOpenIndex((n) => (n !== undefined && n > 0 ? n - 1 : n)),
            onNext: () =>
              setOpenIndex((n) => (n !== undefined && n < items.length - 1 ? n + 1 : n)),
          }}
        />
      )}
    </div>
  )
}
