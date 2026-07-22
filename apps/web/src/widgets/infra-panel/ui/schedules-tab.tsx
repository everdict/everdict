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
import { DetailNav, MetaRow, SectionLabel } from './panel-bits'

// Schedules tab — recurring evals with the panel's OWN navigation: clicking a schedule drills into an in-panel
// detail (cron · pipeline · next fires · last firing). Only eval-axis links (the last scorecard) leave for the
// left half; editing stays on the full schedules page.

const POLL_MS = 30_000

// The authoritative next fire is Temporal's (nextFireTimes); without Temporal deployed, approximate from cron
// (same fallback the schedules page uses).
function upcoming(s: Schedule, count: number): string[] {
  if (s.nextFireTimes && s.nextFireTimes.length > 0) return s.nextFireTimes.slice(0, count)
  return nextFires(s.cron, s.timezone, new Date(), { count }).map((d) => d.toISOString())
}

export function SchedulesTab({ onNavigate }: { onNavigate: () => void }) {
  const t = useTranslations('infraPanel')
  const locale = useLocale()
  const { workspace, schedulesDetail, setSchedulesDetail } = useInfraPanel()
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

  if (schedulesDetail)
    return (
      <ScheduleDetail
        id={schedulesDetail}
        schedules={schedules}
        workspace={workspace}
        locale={locale}
        onBack={() => setSchedulesDetail(null)}
        onNavigate={onNavigate}
      />
    )

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
    return (upcoming(a, 1)[0] ?? '9999').localeCompare(upcoming(b, 1)[0] ?? '9999')
  })

  return (
    <div className="space-y-1 px-3.5 py-3.5">
      {ordered.map((s) => {
        const next = s.enabled ? upcoming(s, 1)[0] : undefined
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => setSchedulesDetail(s.id)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-elevated',
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
          </button>
        )
      })}
    </div>
  )
}

// Schedule drill-in — read from the already-polled list (no extra fetch); the last scorecard is the one
// eval-axis link that navigates the left half.
function ScheduleDetail({
  id,
  schedules,
  workspace,
  locale,
  onBack,
  onNavigate,
}: {
  id: string
  schedules: Schedule[] | null
  workspace: string
  locale: string
  onBack: () => void
  onNavigate: () => void
}) {
  const t = useTranslations('infraPanel')
  const { openRuntime } = useInfraPanel()
  const s = schedules?.find((x) => x.id === id)

  if (!s)
    return (
      <div className="space-y-3 px-3.5 py-3">
        <DetailNav onBack={onBack} />
        {schedules === null ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-faint">
            <Loader2 className="size-3.5 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <p className="py-6 text-center text-[12.5px] text-faint">{t('detailMissing')}</p>
        )}
      </div>
    )

  const fires = s.enabled ? upcoming(s, 3) : []
  const runtime = s.runTemplate.runtime
  return (
    <div className="space-y-3 px-3.5 py-3">
      <DetailNav onBack={onBack} />
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock className="size-4 shrink-0 text-faint" />
        <span className="min-w-0 truncate text-[13px] font-[560]">{s.name}</span>
        <Badge tone={s.enabled ? 'success' : 'neutral'}>
          {s.enabled ? t('enabled') : t('disabled')}
        </Badge>
        {s.lastStatus === 'failed' && <Badge tone="danger">{t('lastFailed')}</Badge>}
      </div>

      {/* Pipeline — what this schedule fires (dataset → harness, + judges when selected). */}
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <EntityRef
          id={s.runTemplate.dataset.id}
          version={s.runTemplate.dataset.version}
          kind="dataset"
        />
        <span className="text-faint">→</span>
        <EntityRef
          id={s.runTemplate.harness.id}
          version={s.runTemplate.harness.version}
          kind="harness"
        />
        {s.runTemplate.judges.map((j) => (
          <EntityRef key={`${j.id}@${j.version}`} id={j.id} version={j.version} kind="judge" />
        ))}
      </div>

      <div className="rounded-md border bg-card px-2.5 py-1.5">
        <MetaRow label={t('cronLabel')}>
          {s.cron} · {describeCron(s.cron, locale)}
        </MetaRow>
        <MetaRow label={t('timezoneLabel')}>{s.timezone}</MetaRow>
        <MetaRow label={t('overlapLabel')}>{s.overlapPolicy}</MetaRow>
        {runtime !== undefined && (
          <MetaRow label={t('runtimeLabel')}>
            <button
              type="button"
              onClick={() =>
                runtime.startsWith('self:')
                  ? openRuntime('runner', runtime.slice('self:'.length))
                  : openRuntime('runtime', runtime)
              }
              className="text-link hover:underline"
            >
              {runtime}
            </button>
          </MetaRow>
        )}
        {s.runTemplate.concurrency !== undefined && (
          <MetaRow label={t('concurrencyLabel')}>{s.runTemplate.concurrency}</MetaRow>
        )}
        {s.runTemplate.trials !== undefined && (
          <MetaRow label={t('trialsLabel')}>{s.runTemplate.trials}</MetaRow>
        )}
        {s.lastFiredAt && (
          <MetaRow label={t('lastFiredLabel')}>
            {fmtDateTime(s.lastFiredAt)}
            {s.lastStatus ? ` · ${s.lastStatus}` : ''}
          </MetaRow>
        )}
      </div>

      {fires.length > 0 && (
        <section className="space-y-1">
          <SectionLabel>{t('nextFiresLabel')}</SectionLabel>
          <div className="rounded-md border bg-card px-2.5 py-1.5">
            {fires.map((f) => (
              <div key={f} className="py-[3px] font-mono text-[11.5px]" title={fmtDateTimeFull(f)}>
                {fmtDateTimeFull(f)}
              </div>
            ))}
          </div>
        </section>
      )}

      {s.lastScorecardId && (
        <Link
          href={`/${workspace}/scorecards/${encodeURIComponent(s.lastScorecardId)}`}
          onClick={onNavigate}
          className="inline-flex items-center gap-1 text-[12px] font-[510] text-link hover:underline"
        >
          {t('lastScorecard')}
        </Link>
      )}
    </div>
  )
}
