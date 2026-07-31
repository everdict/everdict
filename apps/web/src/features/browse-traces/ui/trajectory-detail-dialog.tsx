'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import type { TraceEvent } from '@/entities/trace'
import { fmtDateTimeFull } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'

import { getTrajectoryAction, type TrajectoryMeta } from '../api/browse-trajectories'
import { TraceEventList } from './trace-detail'

// 봉인 궤적 상세 — 우리 스토어(N1)가 가진 증거를 설정 안에서 그대로 연다. run 소스만 run 상세로도 열리므로
// (otlp 도착분은 익스포터가 찍은 everdict.run_id, materialize된 import는 ingest:<scorecardId>:<caseId> 로
// 봉인돼 run 레코드가 없다) 목록의 유일한 상세 표면은 이 다이얼로그다. 외부 플랫폼 트레이스의
// TraceDetailDialog 와 같은 문법(헤더·메타 스트립·prev/next·←/→)을 쓰되, 스팬 워터폴은 없다 — 우리 스토어는
// 정규화된 TraceEvent 를 보관하지 정규화 전 스팬 트리를 보관하지 않는다.
export function TrajectoryDetailDialog({
  open,
  onClose,
  meta,
  nav,
}: {
  open: boolean
  onClose: () => void
  meta: TrajectoryMeta
  nav?: { index: number; total: number; onPrev: () => void; onNext: () => void }
}) {
  const t = useTranslations('trajectoryBrowser')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const { workspace } = useParams<{ workspace: string }>()
  const [events, setEvents] = useState<TraceEvent[] | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [pending, start] = useTransition()

  useEffect(() => {
    if (!open) return
    setEvents(undefined)
    setError(undefined)
    start(async () => {
      const res = await getTrajectoryAction(meta.runId)
      if (res.ok) setEvents(res.events)
      else setError(res.error)
    })
  }, [open, meta.runId])

  // ←/→ 로 형제 궤적 이동 (외부 트레이스 상세와 동일한 조작).
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
      className="flex h-[85vh] max-h-[85vh] max-w-[1100px] flex-col"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0 space-y-1">
          <h2
            id="trajectory-detail-title"
            className="flex items-center gap-2 text-[15px] font-[600]"
          >
            <span className="truncate">{t('detailTitle')}</span>
            <Badge tone="outline">{t(`source_${meta.source}`)}</Badge>
          </h2>
          <div className="truncate font-mono text-[11px] text-faint">{meta.runId}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* run 소스만 run 레코드를 갖는다 — 없는 페이지로 보내는 링크는 아예 걸지 않는다. */}
          {meta.source === 'run' && workspace && (
            <Link
              href={`/${workspace}/runs/${encodeURIComponent(meta.runId)}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <ExternalLink className="size-4" />
              {t('openRun')}
            </Link>
          )}
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

      <div className="flex flex-wrap gap-x-7 gap-y-2 border-b border-border bg-card/50 px-5 py-3">
        <Meta label={t('metaSource')} value={t(`source_${meta.source}`)} />
        <Meta label={t('metaEvents')} value={String(meta.eventCount)} />
        <Meta
          label={t('metaSealedAt')}
          value={fmtDateTimeFull(meta.sealedAt, { locale, timeZone })}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <Callout tone="danger">{error}</Callout>
        ) : pending && !events ? (
          <p className="px-1 py-2 text-[12px] text-faint">{t('loading')}</p>
        ) : events ? (
          <TraceEventList events={events} />
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
