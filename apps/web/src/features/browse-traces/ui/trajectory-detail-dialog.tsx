'use client'

import { useEffect, useState, useTransition } from 'react'
import { useParams } from 'next/navigation'
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import { fmtDateTimeFull } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { CopyLinkButton } from '@/shared/ui/copy-link-button'
import { Dialog } from '@/shared/ui/dialog'
import { Link } from '@/shared/ui/link'

import {
  getTrajectoryAction,
  type TrajectoryMeta,
  type TrajectorySegment,
} from '../api/browse-trajectories'
import { TrajectoryView } from './trajectory-view'

// The sealed trajectory detail — it opens the evidence OUR store (N1) holds, right inside settings. Only a `run` source also opens on a run
// detail (an OTLP arrival is sealed under the everdict.run_id its exporter stamped, and a materialized import under
// ingest:<scorecardId>:<caseId>, so neither has a run record), which makes this dialog the list's only detail surface. It uses the same
// grammar as an external platform trace's TraceDetailDialog (header · meta strip · prev/next · ←/→), and the body opens through
// TrajectoryView as the system view (the agent, batch and service planes plus the full payload).
export function TrajectoryDetailDialog({
  open,
  onClose,
  runId,
  meta,
  nav,
}: {
  open: boolean
  onClose: () => void
  runId: string
  // Carried only when opened from a list row — a dialog opened by deep link (?trajectory=) fills the same slot from the meta the detail read
  // returns (and until then the header stands on the id alone).
  meta?: TrajectoryMeta
  nav?: { index: number; total: number; onPrev: () => void; onNext: () => void }
}) {
  const t = useTranslations('trajectoryBrowser')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const { workspace } = useParams<{ workspace: string }>()
  const [segments, setSegments] = useState<TrajectorySegment[] | undefined>()
  const [fetchedMeta, setFetchedMeta] = useState<TrajectoryMeta | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [pending, start] = useTransition()
  // How much of this trajectory the dialog holds. An ingested trace can be somebody else's five-hour agent,
  // so the open reads a window and the reader asks for the rest — the alternative is an open that costs the
  // whole run before it draws anything.
  const [loaded, setLoaded] = useState(0)
  const [total, setTotal] = useState(0)
  // The store's answer, not ours: absent means this page exhausted the plane.
  const [nextAfter, setNextAfter] = useState<number | undefined>()

  useEffect(() => {
    if (!open) return
    setSegments(undefined)
    setFetchedMeta(undefined)
    setError(undefined)
    setLoaded(0)
    setTotal(0)
    setNextAfter(undefined)
    start(async () => {
      const res = await getTrajectoryAction(runId)
      if (res.ok) {
        setSegments(res.segments)
        setFetchedMeta(res.meta)
        setLoaded(res.events.length)
        setTotal(res.total)
        setNextAfter(res.nextAfter)
      } else setError(res.error)
    })
  }, [open, runId])

  // Append the next window onto the planes already drawn. Segment-wise, because the view reads planes: the
  // page's events belong to whichever emitters it carried, and an emitter absent from this page keeps what
  // it had rather than being reset to nothing.
  const loadMore = () => {
    start(async () => {
      const res = await getTrajectoryAction(runId, nextAfter ?? loaded)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setSegments((held) => {
        if (!held) return res.segments
        const byEmitter = new Map(res.segments.map((s) => [s.emitter, s]))
        const merged = held.map((s) => {
          const more = byEmitter.get(s.emitter)
          byEmitter.delete(s.emitter)
          return more ? { ...s, events: [...s.events, ...more.events] } : s
        })
        return [...merged, ...byEmitter.values()]
      })
      setLoaded((n) => n + res.events.length)
      setNextAfter(res.nextAfter)
    })
  }

  const shown = meta ?? fetchedMeta

  // ←/→ moves between sibling trajectories (the same gesture as the external trace detail).
  const hasPrev = nav !== undefined && nav.index > 0
  const hasNext = nav !== undefined && nav.index < nav.total - 1
  useEffect(() => {
    if (!open || !nav) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft' && hasPrev) nav?.onPrev()
      if (e.key === 'ArrowRight' && hasNext) nav?.onNext()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, nav, hasPrev, hasNext])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="trajectory-detail-title"
      className="flex h-[90vh] max-h-[90vh] max-w-[1400px] flex-col"
    >
      {/* On a narrow screen the action group wraps under the title — the same header grammar as the case detail dialog. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-4">
        <div className="min-w-0 space-y-1">
          <h2
            id="trajectory-detail-title"
            className="flex items-center gap-2 text-[15px] font-[600]"
          >
            <span className="truncate">{t('detailTitle')}</span>
            {shown && <Badge tone="outline">{t(`source_${shown.source}`)}</Badge>}
          </h2>
          <div className="truncate font-mono text-[11px] text-faint">{runId}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Only a `run` source has a run record — a link to a page that does not exist is not attached at all. */}
          {shown?.source === 'run' && workspace && (
            <Link
              href={`/${workspace}/run/${encodeURIComponent(runId)}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <ExternalLink className="size-4" />
              {t('openRun')}
            </Link>
          )}
          {/* The open state is mirrored into the URL as ?trajectory=, so the current address IS this evidence's shareable link. */}
          <CopyLinkButton
            label={t('copyLink')}
            message={t('linkCopied')}
            className="rounded-md border border-border p-1.5 text-muted-foreground"
          />
          {nav && (
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={nav.onPrev}
                disabled={!hasPrev}
                aria-label={t('prev')}
                className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35 disabled:hover:text-muted-foreground"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="min-w-12 text-center font-mono text-[11px] tabular-nums text-faint">
                {nav.index + 1} / {nav.total}
              </span>
              <button
                type="button"
                onClick={nav.onNext}
                disabled={!hasNext}
                aria-label={t('next')}
                className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35 disabled:hover:text-muted-foreground"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* While opening by deep link, with no meta yet, the strip itself folds away (empty-section hiding) — it stands once the detail arrives. */}
      {shown && (
        <div className="flex flex-wrap gap-x-7 gap-y-2 border-b border-border bg-card/50 px-5 py-3">
          <Meta label={t('metaSource')} value={t(`source_${shown.source}`)} />
          <Meta
            label={t('metaSealedAt')}
            value={fmtDateTimeFull(shown.sealedAt, { locale, timeZone })}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 p-4">
        {error ? (
          <Callout tone="danger">{error}</Callout>
        ) : pending && !segments ? (
          <p className="px-1 py-2 text-[12px] text-faint">{t('loading')}</p>
        ) : segments ? (
          <>
            {/* A partial view says so. A trace silently cut is evidence a reader would draw conclusions
                from without knowing what was left out. */}
            {nextAfter !== undefined && (
              <p className="flex items-center gap-3 px-1 pb-2 text-[12px] text-faint">
                <span>{t('traceWindow', { shown: loaded, total })}</span>
                <button className="underline" disabled={pending} onClick={loadMore} type="button">
                  {pending ? t('loading') : t('traceMore')}
                </button>
              </p>
            )}
            <TrajectoryView segments={segments} />
          </>
        ) : null}
      </div>
    </Dialog>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-faint">{label}</span>
      <span className="text-[13px] font-[560] tabular-nums">{value}</span>
    </div>
  )
}
