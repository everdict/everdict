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

// 봉인 궤적 상세 — 우리 스토어(N1)가 가진 증거를 설정 안에서 그대로 연다. run 소스만 run 상세로도 열리므로
// (otlp 도착분은 익스포터가 찍은 everdict.run_id, materialize된 import는 ingest:<scorecardId>:<caseId> 로
// 봉인돼 run 레코드가 없다) 목록의 유일한 상세 표면은 이 다이얼로그다. 외부 플랫폼 트레이스의
// TraceDetailDialog 와 같은 문법(헤더·메타 스트립·prev/next·←/→)을 쓰고, 본문은 TrajectoryView 가
// 시스템 뷰(에이전트·배치·서비스 평면 + 전문 페이로드)로 연다.
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
  // 목록의 행에서 열릴 때만 실려 온다 — 딥링크(?trajectory=)로 연 다이얼로그는 상세 읽기가 돌려주는 meta 로
  // 같은 자리를 채운다(그동안 헤더는 id 만으로 선다).
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
      className="flex h-[90vh] max-h-[90vh] max-w-[1400px] flex-col"
    >
      {/* 좁은 화면에선 액션 묶음이 제목 아래로 줄바꿈된다 — 케이스 상세 다이얼로그와 같은 헤더 문법. */}
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
          {/* run 소스만 run 레코드를 갖는다 — 없는 페이지로 보내는 링크는 아예 걸지 않는다. */}
          {shown?.source === 'run' && workspace && (
            <Link
              href={`/${workspace}/run/${encodeURIComponent(runId)}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <ExternalLink className="size-4" />
              {t('openRun')}
            </Link>
          )}
          {/* 열림 상태가 ?trajectory= 로 URL 에 미러링되므로, 지금 주소가 곧 이 증거의 공유 링크다. */}
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

      {/* 딥링크로 여는 동안 meta 가 아직 없으면 스트립 자체를 접는다(빈 섹션 숨김) — 상세가 도착하면 선다. */}
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
