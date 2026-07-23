'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'

import type { ScorecardStatus } from '@/entities/scorecard'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { MetricChip } from '@/shared/ui/chip'
import { StatusIcon } from '@/shared/ui/status-pill'

// 한 페이지에 노출할 개수 — 대량 렌더를 막고 "더보기"로 점진 노출(저지 이력과 동일).
const PAGE_SIZE = 10

// 실행 이력 한 행에 필요한 최소 데이터 — 서버에서 조립해 전달(직렬화 가능한 평면 형태).
export interface ScheduleRunEntry {
  id: string
  traceEval: boolean // 트레이스 평가 모드인가(dataset/harness 없음)
  metrics: { metric: string; mean: number; passRate?: number | null }[]
  createdAt: string
  status: ScorecardStatus
  runner?: { name: string; avatarUrl?: string }
}

// 이 예약이 만든 스코어카드들의 "주요 지표"를 시간순으로 뽑아 추이를 만든다.
// 주요 지표 = 완료된 실행들에서 가장 자주 등장하는 메트릭(동률이면 먼저 나온 것). 데이터 포인트 2개 미만이면 추이는 그리지 않는다.
function primaryTrend(
  entries: ScheduleRunEntry[]
): { metric: string; points: { at: string; value: number }[] } | null {
  const counts = new Map<string, number>()
  for (const e of entries)
    for (const m of e.metrics) counts.set(m.metric, (counts.get(m.metric) ?? 0) + 1)
  if (counts.size === 0) return null
  let metric = ''
  let best = -1
  for (const [name, n] of counts) {
    if (n > best) {
      best = n
      metric = name
    }
  }
  // 오래된 → 최신 순으로(입력은 최신순). 해당 메트릭이 있는 실행만.
  const points = [...entries]
    .reverse()
    .map((e) => {
      const m = e.metrics.find((x) => x.metric === metric)
      return m ? { at: e.createdAt, value: m.mean } : null
    })
    .filter((p): p is { at: string; value: number } => p !== null)
  return points.length >= 2 ? { metric, points } : null
}

// 추이 스파크라인 — 주요 지표의 평균값을 시간순 꺾은선으로. 값의 좋고 나쁨은 가정하지 않는다(중립).
function RunTrend({ entries }: { entries: ScheduleRunEntry[] }) {
  const t = useTranslations('scheduleDetail')
  const trend = useMemo(() => primaryTrend(entries), [entries])
  if (!trend) return null

  const values = trend.points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const n = trend.points.length
  const coords = trend.points.map((p, i) => {
    const x = n === 1 ? 50 : (i / (n - 1)) * 100
    const y = span === 0 ? 50 : 100 - ((p.value - min) / span) * 100
    return { x, y }
  })
  const line = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ')
  const first = values[0] ?? 0
  const last = values[values.length - 1] ?? 0
  const delta = last - first

  return (
    <div className="rounded-lg border bg-card/60 p-3.5 shadow-raise">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span
          className="truncate font-mono text-[11.5px] text-muted-foreground"
          title={trend.metric}
        >
          {t('trendLabel', { metric: trend.metric })}
        </span>
        <span className="shrink-0 tabular-nums text-[12px]">
          <span className="font-[560] text-foreground">{last.toFixed(2)}</span>
          {delta !== 0 && (
            <span className="ml-1.5 text-[11px] text-faint">
              {delta > 0 ? '+' : ''}
              {delta.toFixed(2)}
            </span>
          )}
        </span>
      </div>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-14 w-full text-[var(--color-primary)]"
        role="img"
        aria-label={t('trendLabel', { metric: trend.metric })}
      >
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {coords.map((c, i) => (
          <circle
            key={`${c.x}-${i}`}
            cx={c.x}
            cy={c.y}
            r={1.6}
            fill="currentColor"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  )
}

// 예약 상세의 실행 이력 — 이 예약이 만든 스코어카드들(최신순). 상단에 주요 지표 추이 스파크라인.
// 행: 상태 · 주요 지표 칩 · (트레이스 평가 태그) · 실행자 · 시각 → 스코어카드 상세로 링크.
export function ScheduleRuns({
  workspace,
  entries,
  timeZone,
}: {
  workspace: string
  entries: ScheduleRunEntry[]
  timeZone: string
}) {
  const t = useTranslations('scheduleDetail')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const shown = entries.slice(0, visible)
  const remaining = entries.length - shown.length

  return (
    <div className="space-y-3">
      <RunTrend entries={entries} />
      <div className="space-y-2">
        {shown.map((s) => {
          const siblings = s.metrics.map((m) => m.metric)
          return (
            <Link
              key={s.id}
              href={`/${workspace}/scorecards/${encodeURIComponent(s.id)}`}
              className="group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <span className="flex w-5 shrink-0 justify-center">
                <StatusIcon status={s.status} />
              </span>
              {/* 주요 지표 칩 — 예약은 대상(데이터셋·하네스)이 고정이라 지표가 행의 주 정보. */}
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                {s.traceEval && (
                  <span className="mr-1 shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] font-[510] text-muted-foreground">
                    {t('traceEvalTag')}
                  </span>
                )}
                {s.metrics.slice(0, 3).map((m) => (
                  <span key={m.metric} className="shrink-0">
                    <MetricChip
                      metric={m.metric}
                      mean={m.mean}
                      passRate={m.passRate}
                      siblings={siblings}
                    />
                  </span>
                ))}
                {s.metrics.length > 3 && (
                  <span className="shrink-0 text-[11px] text-faint">+{s.metrics.length - 3}</span>
                )}
                {s.metrics.length === 0 && (
                  <span className="truncate text-[12px] text-faint">{t('runNoMetrics')}</span>
                )}
              </div>
              {/* 실행자 · 시각 — 고정 폭 */}
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="flex w-6 justify-center">
                  {s.runner && (
                    <UserAvatar
                      name={s.runner.name}
                      url={s.runner.avatarUrl}
                      label={t('runRunner')}
                    />
                  )}
                </span>
                <time
                  className="hidden w-[84px] text-right font-mono text-[11px] text-muted-foreground sm:block"
                  title={fmtDateTimeFull(s.createdAt, { timeZone })}
                >
                  {fmtDateTime(s.createdAt, timeZone)}
                </time>
              </div>
            </Link>
          )
        })}
        {remaining > 0 && (
          <button
            type="button"
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            className="w-full rounded-lg border border-dashed border-border px-3.5 py-2 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:bg-elevated hover:text-foreground"
          >
            {t('runsLoadMore', { count: remaining })}
          </button>
        )}
      </div>
    </div>
  )
}
