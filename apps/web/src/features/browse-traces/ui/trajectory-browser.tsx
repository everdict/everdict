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

// The run families a trajectory can belong to (`RUN_KINDS`), plus "everything". `undefined` = no filter.
const KIND_FILTERS: (string | undefined)[] = [
  undefined,
  'agent',
  'eval',
  'sandbox',
  'command',
  'analysis',
]

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
  const [kind, setKind] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)

  const load = useCallback((cursor?: string, forKind?: string) => {
    void (async () => {
      setPending(true)
      try {
        const page = await listTrajectoriesAction({
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          ...(forKind ? { kind: forKind } : {}),
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

  // Switching the kind restarts paging — the cursor belongs to the query that produced it.
  useEffect(() => {
    setItems([])
    setNextCursor(undefined)
    setLoaded(false)
    load(undefined, kind)
  }, [load, kind])

  if (error) return <Callout tone="danger">{error}</Callout>
  return (
    <div className="space-y-2">
      {/* The kind axis. Every row used to read `<uuid> · run · N events`, so a member looking for the trace of
          the agent they just ran could not tell which row was theirs — evidence you cannot recognize reads as
          evidence that is not there. Filtering happens in the store's query, so a page is never short. */}
      <div className="flex flex-wrap items-center gap-1">
        {KIND_FILTERS.map((k) => (
          <Button
            key={k ?? 'all'}
            variant={kind === k ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setKind(k)}
            disabled={pending}
          >
            {k === undefined ? t('kindAll') : t(`kind_${k}`)}
          </Button>
        ))}
      </div>
      {loaded && items.length === 0 ? (
        <EmptyState
          title={kind ? t('emptyKindTitle') : t('emptyTitle')}
          hint={kind ? t('emptyKindHint') : t('emptyHint')}
        />
      ) : (
        <>
          <div className="text-xs text-muted-foreground">{t('count', { count: items.length })}</div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {items.map((m, i) => (
              <li key={m.runId}>
                <button
                  type="button"
                  onClick={() => setOpenIndex(i)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  {/* The handle first (what a person recognizes), the id second (what they paste into a search). */}
                  <span className="min-w-0 flex-1 truncate">
                    {m.label ? (
                      <>
                        <span className="text-foreground">{m.label}</span>
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {m.runId}
                        </span>
                      </>
                    ) : (
                      <span className="font-mono text-xs">{m.runId}</span>
                    )}
                  </span>
                  {m.kind ? <Badge tone="outline">{t(`kind_${m.kind}`)}</Badge> : null}
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() => load(nextCursor, kind)}
              disabled={pending}
            >
              {t('loadMore')}
            </Button>
          ) : null}
        </>
      )}
      {/* prev/next moves only within the pages already loaded — the dialog never pulls the cursor further. */}
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
