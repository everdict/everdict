'use client'

import { useMemo } from 'react'

import type { Schedule } from '@/entities/schedule'
import { describeCron, firesOnDate } from '@/shared/lib/cron'
import { cn } from '@/shared/lib/utils'

import { type Author, ownerNameOf } from './schedule-card'

const DOW_HEADERS = ['일', '월', '화', '수', '목', '금', '토'] as const
const CELL_LIMIT = 3 // 셀에 이름으로 보여줄 최대 예약 수(넘치면 +N)

// 예약 캘린더(월) — 각 날짜 셀에 그날 발사되는 예약을 이름 칩으로. 반복이 조밀해도 예약당 하루 1개만
// 표시(분·시 무관, firesOnDate O(1))라 뭉개지지 않는다. 시각별 나열은 '다가오는 실행' 타임라인이 담당.
export function ScheduleCalendar({
  schedules,
  authors,
  nowIso,
}: {
  schedules: Schedule[]
  authors: Record<string, Author>
  nowIso: string
}) {
  // 월/오늘은 nowIso(UTC 기준)에서 결정 — 서버/클라 동일(hydration 안전). 월뷰 오차는 자정 경계 근사.
  const { year, month, todayDay, cells, leading } = useMemo(() => {
    const now = new Date(nowIso)
    const y = now.getUTCFullYear()
    const mo = now.getUTCMonth() + 1
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
    const firstDow = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay()
    const active = schedules.filter((s) => s.enabled)
    const days = []
    for (let d = 1; d <= daysInMonth; d++)
      days.push({ day: d, fires: active.filter((s) => firesOnDate(s.cron, y, mo, d)) })
    return { year: y, month: mo, todayDay: now.getUTCDate(), cells: days, leading: firstDow }
  }, [schedules, nowIso])

  return (
    <div className="rounded-lg border bg-card p-4 shadow-raise">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-[14px] font-[560]">
          {year}년 {month}월
        </div>
        <div className="text-[11px] text-faint">활성 예약의 발사 일자 (UTC 기준 근사)</div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {DOW_HEADERS.map((d, i) => (
          <div
            key={d}
            className={cn(
              'pb-1 text-center text-[11px] font-[510] text-faint',
              i === 0 && 'text-destructive/70'
            )}
          >
            {d}
          </div>
        ))}
        {Array.from({ length: leading }).map((_, i) => (
          <div key={`lead-${i}`} />
        ))}
        {cells.map(({ day, fires }) => (
          <div
            key={day}
            className={cn(
              'min-h-[76px] rounded-md border bg-background/40 p-1.5 transition-colors',
              day === todayDay ? 'border-primary/60 ring-1 ring-primary/30' : 'border-border/60'
            )}
          >
            <div
              className={cn(
                'mb-1 text-[11px] font-[510] tabular-nums',
                day === todayDay ? 'text-[var(--color-link)]' : 'text-muted-foreground'
              )}
            >
              {day}
            </div>
            <div className="space-y-0.5">
              {fires.slice(0, CELL_LIMIT).map((s) => (
                <div
                  key={s.id}
                  className="truncate rounded bg-secondary px-1 py-0.5 text-[10.5px] leading-tight text-secondary-foreground"
                  title={`${s.name} · ${describeCron(s.cron)} · ${ownerNameOf(authors, s.createdBy)}`}
                >
                  {s.name}
                </div>
              ))}
              {fires.length > CELL_LIMIT && (
                <div className="px-1 text-[10px] text-faint">+{fires.length - CELL_LIMIT}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
