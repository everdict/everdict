'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { LiveLogs } from '@/widgets/live-logs'
import { LiveScreen } from '@/widgets/sandbox-terminal'
import { runsSchema, type Run } from '@/entities/run'
import { fmtDateTime, fmtDateTimeFull, fmtScoreDetail } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EntityRef } from '@/shared/ui/chip'
import { MetricLabel } from '@/shared/ui/metric-label'
import { StatusIcon, StatusPill } from '@/shared/ui/status-pill'

import { useInfraPanel } from '../model/infra-panel-context'
import { DetailNav, SectionLabel } from './panel-bits'

// Runs tab — the live half of the split view. Without a selection: the execution feed (active first, then the
// latest settled). Selecting a run swaps in its uninterrupted live view (screen frames + log tail) right here in
// the panel, so the user keeps browsing eval pages on the left while the run streams on the right. The tab stays
// mounted while a run is selected (see InfraPanel), so navigation or peeking at another tab never restarts the stream.

const POLL_MS = 5_000
const LIST_CAP = 15

const ACTIVE = new Set(['queued', 'running'])

export function RunsTab() {
  const t = useTranslations('infraPanel')
  const { selectedRunId, selectRun } = useInfraPanel()
  const [runs, setRuns] = useState<Run[] | null>(null)

  // Poll the execution feed (scope=all folds in scorecard children — those are the runs worth watching live).
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch('/api/runs', { cache: 'no-store' })
        if (res.ok) {
          const parsed = runsSchema.safeParse(await res.json())
          if (stopped) return
          if (parsed.success) setRuns(parsed.data)
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

  const { active, recent } = useMemo(() => {
    const all = runs ?? []
    const active = all
      .filter((r) => ACTIVE.has(r.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const recent = all
      .filter((r) => !ACTIVE.has(r.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, LIST_CAP)
    return { active, recent }
  }, [runs])

  if (selectedRunId) {
    const selected = runs?.find((r) => r.id === selectedRunId)
    const scores = selected?.result?.scores ?? []
    return (
      <div className="space-y-3 px-3.5 py-3">
        <DetailNav onBack={() => selectRun(null)} />

        <div className="flex flex-wrap items-center gap-2">
          {selected && <StatusPill status={selected.status} />}
          {selected && (
            <span className="min-w-0 truncate text-[12.5px] font-[510]">
              <EntityRef
                id={selected.harness.id}
                version={selected.harness.version}
                kind="harness"
              />
            </span>
          )}
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {selected ? selected.caseId : selectedRunId}
          </span>
        </div>

        {selected?.error && (
          <Callout tone="danger" className="px-2.5 py-2 text-[12px]">
            <span className="font-mono">{selected.error.code}</span> {selected.error.message}
          </Callout>
        )}

        {/* Live stream — the widgets poll the BFF themselves and stop on a terminal status. initialStatus falls
            back to running when the feed hasn't listed this run yet (openRun from a left page), so polling starts. */}
        <LiveScreen runId={selectedRunId} initialStatus={selected?.status ?? 'running'} />
        <LiveLogs runId={selectedRunId} initialStatus={selected?.status ?? 'running'} />

        {/* Verdict — per-metric scores once graded (the panel shows the full run content; there is no full-page hop). */}
        {scores.length > 0 && (
          <section className="space-y-1">
            <SectionLabel count={scores.length}>{t('scoresLabel')}</SectionLabel>
            <div className="space-y-1">
              {scores.map((s) => {
                const detailText = fmtScoreDetail(s.detail)
                return (
                  <div
                    key={`${s.graderId}:${s.metric}`}
                    className="rounded-md border bg-card px-2.5 py-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
                        <MetricLabel metric={s.metric} siblings={scores.map((x) => x.metric)} />
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="font-mono text-[12px] font-[560] tabular-nums">
                          {s.value}
                        </span>
                        {s.pass != null && (
                          <Badge tone={s.pass ? 'success' : 'danger'}>
                            {s.pass ? 'pass' : 'fail'}
                          </Badge>
                        )}
                      </span>
                    </div>
                    {detailText && (
                      <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                        {detailText}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>
    )
  }

  if (!runs)
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-faint">
        <Loader2 className="size-3.5 animate-spin" /> {t('loading')}
      </div>
    )

  if (active.length === 0 && recent.length === 0)
    return <p className="py-8 text-center text-[12.5px] text-faint">{t('runsEmpty')}</p>

  return (
    <div className="space-y-4 px-3.5 py-3.5">
      <RunSection title={t('activeRuns')} runs={active} onSelect={selectRun} />
      <RunSection title={t('recentRuns')} runs={recent} onSelect={selectRun} />
    </div>
  )
}

// Compact run rows — click = watch it live in place (not a navigation; the left page stays).
function RunSection({
  title,
  runs,
  onSelect,
}: {
  title: string
  runs: Run[]
  onSelect: (id: string) => void
}) {
  if (runs.length === 0) return null
  return (
    <section className="space-y-1">
      <div className="flex items-center gap-1.5 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
        {title}
        <span className="tabular-nums text-muted-foreground">{runs.length}</span>
      </div>
      <div className="space-y-1">
        {runs.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onSelect(r.id)}
            className="flex w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-elevated"
          >
            <StatusIcon status={r.status} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 space-y-0.5 overflow-hidden whitespace-nowrap">
              <span className="block truncate text-[12px] font-[510]">
                <EntityRef id={r.harness.id} version={r.harness.version} kind="harness" />
              </span>
              <span className="block truncate font-mono text-[10.5px] text-faint">
                {r.caseId}
                {r.trigger ? ` · ${r.trigger}` : ''}
              </span>
            </span>
            <time
              className="w-[68px] shrink-0 text-right font-mono text-[10.5px] text-muted-foreground"
              title={fmtDateTimeFull(r.createdAt)}
            >
              {fmtDateTime(r.createdAt)}
            </time>
          </button>
        ))}
      </div>
    </section>
  )
}
