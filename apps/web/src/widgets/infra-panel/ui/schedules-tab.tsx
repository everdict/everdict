'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CalendarClock, Loader2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { schedulesSchema, type Schedule } from '@/entities/schedule'
import { describeCron, nextFires } from '@/shared/lib/cron'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { EntityRef } from '@/shared/ui/chip'

import { useInfraPanel } from '../model/infra-panel-context'

// Schedules tab — the recurring evals at a glance: what fires next and how the last firing went. Enabled
// schedules first, sorted by next fire. Editing stays on the full schedules page.

const POLL_MS = 30_000

// The authoritative next fire is Temporal's (nextFireTimes); without Temporal deployed, approximate from cron
// (same fallback the schedules page uses).
function nextFire(s: Schedule): string | undefined {
  if (s.nextFireTimes && s.nextFireTimes.length > 0) return s.nextFireTimes[0]
  const approx = nextFires(s.cron, s.timezone, new Date(), { count: 1 })
  return approx[0]?.toISOString()
}

export function SchedulesTab({ onNavigate }: { onNavigate: () => void }) {
  const t = useTranslations('infraPanel')
  const locale = useLocale()
  const { workspace } = useInfraPanel()
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch('/api/schedules', { cache: 'no-store' })
        if (res.ok) {
          const parsed = schedulesSchema.safeParse(await res.json())
          if (stopped) return
          if (parsed.success) setSchedules(parsed.data)
        }
      } catch {
        // transient — keep polling
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (!schedules)
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-faint">
        <Loader2 className="size-3.5 animate-spin" /> {t('loading')}
      </div>
    )

  if (schedules.length === 0)
    return <p className="py-8 text-center text-[12.5px] text-faint">{t('schedulesEmpty')}</p>

  const ordered = [...schedules].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return (nextFire(a) ?? '9999').localeCompare(nextFire(b) ?? '9999')
  })

  return (
    <div className="space-y-1 px-3.5 py-3.5">
      {ordered.map((s) => {
        const next = s.enabled ? nextFire(s) : undefined
        return (
          <Link
            key={s.id}
            href={`/${workspace}/schedules`}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 transition-colors hover:border-border-strong hover:bg-elevated',
              !s.enabled && 'opacity-60'
            )}
          >
            <CalendarClock className="size-3.5 shrink-0 text-faint" />
            <span className="min-w-0 flex-1 space-y-0.5 overflow-hidden whitespace-nowrap">
              <span className="flex items-center gap-1.5 text-[12px] font-[510]">
                <span className="min-w-0 truncate">{s.name}</span>
                {!s.enabled && (
                  <Badge tone="neutral" className="shrink-0">
                    {t('disabled')}
                  </Badge>
                )}
                {s.lastStatus === 'failed' && (
                  <Badge tone="danger" className="shrink-0">
                    {t('lastFailed')}
                  </Badge>
                )}
              </span>
              <span className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[10.5px] text-faint">
                <span className="min-w-0 truncate">
                  <EntityRef
                    id={s.runTemplate.dataset.id}
                    version={s.runTemplate.dataset.version}
                    kind="dataset"
                  />
                </span>
                <span>→</span>
                <span className="min-w-0 truncate">
                  <EntityRef
                    id={s.runTemplate.harness.id}
                    version={s.runTemplate.harness.version}
                    kind="harness"
                  />
                </span>
                <span className="hidden truncate sm:inline">· {describeCron(s.cron, locale)}</span>
              </span>
            </span>
            {next && (
              <time
                className="shrink-0 text-right font-mono text-[10.5px] text-muted-foreground"
                title={fmtDateTimeFull(next)}
              >
                {fmtDateTime(next)}
              </time>
            )}
          </Link>
        )
      })}
    </div>
  )
}
