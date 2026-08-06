'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import { fmtDateTimeFull, fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
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
export function TrajectoryBrowser({
  initialOpenId,
}: {
  // The ?trajectory= deep-link param the settings page read server-side — when set, the detail dialog
  // self-opens on that id (the detail read carries its own meta, so the id need not be in the loaded list).
  initialOpenId?: string
}) {
  const t = useTranslations('trajectoryBrowser')
  const locale = useLocale()
  const timeZone = useTimeZone()
  // The open dialog is keyed by trajectory ID, not list index: a deep-linked id can open before (or without)
  // the page that contains it, and a list replacement can never re-point the dialog at a different row.
  const [openId, setOpenId] = useState<string | undefined>(initialOpenId)
  const [items, setItems] = useState<TrajectoryMeta[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [kind, setKind] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  // Load generation — a newer query supersedes an in-flight one, so a slow page for the kind you just left
  // can never land on top of the kind you are now looking at.
  const genRef = useRef(0)

  const load = useCallback((cursor?: string, forKind?: string) => {
    const gen = ++genRef.current
    void (async () => {
      setPending(true)
      try {
        const page = await listTrajectoriesAction({
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          ...(forKind ? { kind: forKind } : {}),
        })
        if (gen !== genRef.current) return // superseded — drop this page, and its pending/error with it
        if (!page.ok) {
          setError(page.error)
          return
        }
        setError(undefined)
        // The list is REPLACED when the new page arrives, never emptied while it is on the way: clearing on
        // the click collapsed the list to an empty bordered box and re-expanded it a moment later, which
        // reads as the whole section blinking on every filter press. Paging appends, as before.
        setItems((prev) => (cursor ? [...prev, ...page.items] : page.items))
        setNextCursor(page.nextCursor)
        setLoaded(true)
      } finally {
        if (gen === genRef.current) setPending(false)
      }
    })()
  }, [])

  // Switching the kind restarts paging — the cursor belongs to the query that produced it. The previous
  // rows stay on screen (dimmed) until the new ones land.
  useEffect(() => {
    load(undefined, kind)
  }, [load, kind])

  // Mirror the dialog into the URL (?trajectory=<id>, replaceState) so the address bar is a shareable link to
  // the evidence on screen; removed on close, so a refresh doesn't resurrect a dismissed dialog. Other params
  // (the platform browser's ?source=&trace= pair) are preserved — only our own is touched. The state argument
  // MUST be null: passing window.history.state carries Next's __NA marker, which makes its history patch skip
  // the router-canonical-URL sync — and the next server action then RESTORES the stale address (verified live).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (openId !== undefined) params.set('trajectory', openId)
    else params.delete('trajectory')
    const query = params.toString()
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${query.length > 0 ? `?${query}` : ''}${window.location.hash}`
    )
  }, [openId])

  // The open row's meta/index, recomputed from whatever the list currently holds — absent for a deep-linked id
  // outside the loaded window (the dialog then reads its meta from the detail response and offers no prev/next).
  const openMeta = openId === undefined ? undefined : items.find((m) => m.runId === openId)
  const openIdx = openMeta === undefined ? -1 : items.indexOf(openMeta)

  if (error) return <Callout tone="danger">{error}</Callout>
  return (
    <div className="space-y-2">
      {/* The kind axis. Every row used to read `<uuid> · run · N events`, so a member looking for the trace of
          the agent they just ran could not tell which row was theirs — evidence you cannot recognize reads as
          evidence that is not there. Filtering happens in the store's query, so a page is never short. */}
      <div className="flex flex-wrap items-center gap-1">
        {/* Never disabled while a page is in flight: a greyed-out row of buttons is its own flicker, and the
            load generation already makes a second press safe. */}
        {KIND_FILTERS.map((k) => (
          <Button
            key={k ?? 'all'}
            variant={kind === k ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setKind(k)}
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
        <div
          className={cn('space-y-2 transition-opacity', pending && 'opacity-60')}
          aria-busy={pending}
        >
          <div className="text-xs text-muted-foreground">{t('count', { count: items.length })}</div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {items.map((m) => (
              <li key={m.runId}>
                <button
                  type="button"
                  onClick={() => setOpenId(m.runId)}
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
        </div>
      )}
      {/* prev/next moves only within the pages already loaded — the dialog never pulls the cursor further. */}
      {openId !== undefined && (
        <TrajectoryDetailDialog
          open
          onClose={() => setOpenId(undefined)}
          runId={openId}
          {...(openMeta ? { meta: openMeta } : {})}
          {...(openMeta
            ? {
                nav: {
                  index: openIdx,
                  total: items.length,
                  onPrev: () => {
                    const prev = items[openIdx - 1]
                    if (prev) setOpenId(prev.runId)
                  },
                  onNext: () => {
                    const next = items[openIdx + 1]
                    if (next) setOpenId(next.runId)
                  },
                },
              }
            : {})}
        />
      )}
    </div>
  )
}
