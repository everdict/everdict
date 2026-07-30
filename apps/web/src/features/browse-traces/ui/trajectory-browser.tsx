'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'
import { fmtDateTimeFull, fmtTimeAgo } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { listTrajectoriesAction, type TrajectoryMeta } from '../api/browse-trajectories'

const PAGE_SIZE = 25

// The OWNED evidence ledger's browse list (native-observability N1 "look inward"): every sealed trajectory
// this workspace holds — our own executions, OTLP-door arrivals, materialized imports — newest first. The
// run is the home: a row opens the run's detail page, where the sealed events render on the existing
// timeline. Deliberately simpler than the platform TraceBrowser: no source axis, no scope — this is OUR
// store, one list.
export function TrajectoryBrowser() {
  const t = useTranslations('trajectoryBrowser')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const { workspace } = useParams<{ workspace: string }>()
  const [items, setItems] = useState<TrajectoryMeta[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [pending, startTransition] = useTransition()

  const load = useCallback((cursor?: string) => {
    startTransition(async () => {
      const page = await listTrajectoriesAction({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) })
      if (!page.ok) {
        setError(page.error)
        return
      }
      setError(undefined)
      setItems((prev) => (cursor ? [...prev, ...page.items] : page.items))
      setNextCursor(page.nextCursor)
      setLoaded(true)
    })
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
        {items.map((m) => (
          <li key={m.runId}>
            <Link
              href={`/${workspace}/runs/${encodeURIComponent(m.runId)}`}
              className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent"
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
            </Link>
          </li>
        ))}
      </ul>
      {nextCursor ? (
        <Button variant="secondary" size="sm" onClick={() => load(nextCursor)} disabled={pending}>
          {t('loadMore')}
        </Button>
      ) : null}
    </div>
  )
}
