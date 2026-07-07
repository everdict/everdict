'use client'

import { useMemo } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import type { Schedule } from '@/entities/schedule'
import { describeCron, firesOnDate } from '@/shared/lib/cron'
import { cn } from '@/shared/lib/utils'

import { ownerNameOf, type Author } from './schedule-card'

const DOW_KEYS = ['dowSun', 'dowMon', 'dowTue', 'dowWed', 'dowThu', 'dowFri', 'dowSat'] as const
const CELL_LIMIT = 3 // max schedules shown by name per cell (overflow shows +N)

// Schedule calendar (month) — each date cell shows the schedules firing that day as name chips. Even with dense
// repetition it stays uncluttered because each schedule shows at most once per day (regardless of minute/hour, firesOnDate O(1)). Per-time listing is handled by the 'upcoming runs' timeline.
export function ScheduleCalendar({
  schedules,
  authors,
  nowIso,
}: {
  schedules: Schedule[]
  authors: Record<string, Author>
  nowIso: string
}) {
  const t = useTranslations('manageSchedules')
  const locale = useLocale()
  // Month/today are derived from nowIso (UTC-based) — identical on server/client (hydration-safe). Month-view drift is a midnight-boundary approximation.
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
        <div className="text-[14px] font-[560]">{t('monthYear', { year, month })}</div>
        <div className="text-[11px] text-faint">{t('calendarNote')}</div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {DOW_KEYS.map((key, i) => (
          <div
            key={key}
            className={cn(
              'pb-1 text-center text-[11px] font-[510] text-faint',
              i === 0 && 'text-destructive/70'
            )}
          >
            {t(key)}
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
                  title={`${s.name} · ${describeCron(s.cron, locale)} · ${ownerNameOf(authors, s.createdBy)}`}
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
