'use client'

import Link from 'next/link'
import { CalendarClock, ChevronsRight, CircleDashed, Laptop, Loader2, Server } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { type QueueItem, type QueueLane, type QueueSnapshot } from '@/entities/queue'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { UserAvatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { EntityRef } from '@/shared/ui/chip'

import { useInfraPanel, type WorkAuthor } from '../model/infra-panel-context'

// Work tab — the queue snapshot rendered vertically (docs/architecture/work-queue.md): top summary + scheduler
// admission + per-lane flow (upcoming ⇢ queued ⇢ running). Moved from the former standalone work rail into the
// infra panel. Running single runs additionally get a live-view shortcut that opens them in the runs tab.

type Translate = ReturnType<typeof useTranslations<'workPanel'>>

// Lane label — prefer the server-provided label (the runner hostname). '' = the default backend.
function laneLabel(lane: QueueLane, t: Translate): string {
  if (lane.label) return lane.label
  if (lane.runtime === '') return t('defaultBackend')
  if (lane.runtime.startsWith('self:')) return lane.runtime.slice('self:'.length)
  return lane.runtime
}

// Batch progress — if total is known, a bar + n/total, otherwise a done/running count as text.
function Progress({ progress }: { progress: NonNullable<QueueItem['progress']> }) {
  const t = useTranslations('workPanel')
  const { done, active, waiting, total } = progress
  if (total && total > 0) {
    const pct = Math.min(100, Math.round((done / total) * 100))
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-muted/60">
          <span className="block h-full bg-primary" style={{ width: `${pct}%` }} />
        </span>
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
        {active > 0 && (
          <span className="shrink-0 text-[10.5px] text-faint">
            {t('runningSuffix', { active })}
          </span>
        )}
        {waiting > 0 && (
          <span className="shrink-0 text-[10.5px] text-faint">
            {t('waitingSuffix', { waiting })}
          </span>
        )}
      </span>
    )
  }
  return (
    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
      {waiting > 0
        ? t('doneRunningWaiting', { done, active, waiting })
        : t('doneRunning', { done, active })}
    </span>
  )
}

// Work item — a fixed one-line format: dataset→harness + progress/status + runner·time. Navigation splits by
// axis: a run opens IN-PANEL (runs tab live view — the panel navigates itself); a scorecard is an eval-axis
// entity, so it navigates the left half (closing the panel on mobile).
function ItemRow({
  item,
  workspace,
  authors,
  onNavigate,
  next,
}: {
  item: QueueItem
  workspace: string
  authors: Record<string, WorkAuthor>
  onNavigate: () => void
  next?: boolean
}) {
  const t = useTranslations('workPanel')
  const { openRun } = useInfraPanel()
  const author = item.createdBy
    ? (authors[item.createdBy] ?? { name: fmtSubject(item.createdBy) })
    : undefined
  const body = (
    <>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px] font-[510]">
          {next && (
            <Badge tone="info" className="shrink-0">
              {t('nextBadge')}
            </Badge>
          )}
          {item.dataset ? (
            <>
              <span className="min-w-0 truncate">
                <EntityRef id={item.dataset.id} version={item.dataset.version} kind="dataset" />
              </span>
              <span className="shrink-0 text-faint">→</span>
            </>
          ) : null}
          <span className="min-w-0 truncate">
            <EntityRef id={item.harness.id} version={item.harness.version} kind="harness" />
          </span>
        </div>
        <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
          {item.status === 'running' ? (
            item.progress ? (
              <Progress progress={item.progress} />
            ) : (
              <span className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> {t('running')}
              </span>
            )
          ) : (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-faint">
              <CircleDashed className="size-3" /> {t('queued')}
            </span>
          )}
          {item.trigger && (
            <span className="hidden text-[10.5px] text-faint sm:inline">{item.trigger}</span>
          )}
        </div>
      </div>
      <span className="flex w-5 shrink-0 justify-center">
        {author && (
          <UserAvatar name={author.name} url={author.avatarUrl} label={t('runnerLabel')} />
        )}
      </span>
      <time
        className="w-[68px] shrink-0 text-right font-mono text-[10.5px] text-muted-foreground"
        title={fmtDateTimeFull(item.createdAt)}
      >
        {fmtDateTime(item.createdAt)}
      </time>
    </>
  )
  const rowClass =
    'flex w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-elevated'
  if (item.type === 'run')
    return (
      <button type="button" onClick={() => openRun(item.id)} className={rowClass}>
        {body}
      </button>
    )
  return (
    <Link
      href={`/${workspace}/scorecards/${encodeURIComponent(item.id)}`}
      onClick={onNavigate}
      className={rowClass}
    >
      {body}
    </Link>
  )
}

// Upcoming fire — clicking drills into that schedule's in-panel detail (schedules tab), not the left router.
function UpcomingRow({ upcoming }: { upcoming: QueueLane['upcoming'][number] }) {
  const { openSchedule } = useInfraPanel()
  return (
    <button
      type="button"
      onClick={() => openSchedule(upcoming.scheduleId)}
      className="flex w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-elevated"
    >
      <CalendarClock className="size-3.5 shrink-0 text-faint" />
      <div className="min-w-0 flex-1 space-y-0.5 overflow-hidden whitespace-nowrap">
        <div className="truncate text-[12px] font-[510]">{upcoming.name}</div>
        <div className="truncate font-mono text-[10.5px] text-faint">
          {upcoming.dataset} → {upcoming.harness}
        </div>
      </div>
      <time
        className="shrink-0 font-mono text-[10.5px] text-muted-foreground"
        title={fmtDateTimeFull(upcoming.at)}
      >
        {fmtDateTime(upcoming.at)}
      </time>
    </button>
  )
}

// A subsection within a lane (running / queued / upcoming) — title + count, not rendered when empty (the hide-empty-sections rule).
function LaneSection({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
        {title}
        <span className="tabular-nums text-muted-foreground">{count}</span>
      </div>
      {children}
    </div>
  )
}

// Scheduler admission utilization — an in-flight vs declared-slots (maxConcurrent) bar + mem/cpu budget + circuit state.
function Admission({ lane }: { lane: QueueLane }) {
  const t = useTranslations('workPanel')
  const a = lane.admission
  if (!a) return null
  const max = a.maxConcurrent
  const slots = max !== undefined && max > 0 ? max : undefined // declared slots (narrow)
  const pct =
    slots !== undefined ? Math.min(100, Math.round((a.inFlight / slots) * 100)) : undefined
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {slots !== undefined && pct !== undefined ? (
        <span className="flex items-center gap-1.5" title={t('admissionSlotsTitle')}>
          <span className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted/60">
            <span
              className={cn(
                'block h-full',
                pct >= 100 ? 'bg-[var(--color-warning)]' : 'bg-[#6ec6a8]'
              )}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
            {t('admissionSlots', { used: a.inFlight, max: slots })}
          </span>
        </span>
      ) : (
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {t('admissionInFlight', { inFlight: a.inFlight })}
        </span>
      )}
      {a.memoryBudgetMb !== undefined && (
        <span
          className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint"
          title={t('admissionMemoryTitle')}
        >
          {t('admissionMemory', { used: a.memInFlightMb ?? 0, budget: a.memoryBudgetMb })}
        </span>
      )}
      {a.cpuBudget !== undefined && (
        <span
          className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint"
          title={t('admissionCpuTitle')}
        >
          {t('admissionCpu', { used: a.cpuInFlight ?? 0, budget: a.cpuBudget })}
        </span>
      )}
      {a.circuit?.open && (
        <Badge
          tone="danger"
          className="shrink-0"
          title={t('circuitOpenTitle', { n: a.circuit.consecutive })}
        >
          {t('circuitOpen')}
        </Badge>
      )}
    </div>
  )
}

// Runtime lane card — a header (icon·label·stats·admission) + the flow (upcoming ⇢ queued ⇢ running). Idle lanes are collapsed and dimmed.
function LaneCard({
  lane,
  workspace,
  authors,
  onNavigate,
  personal,
}: {
  lane: QueueLane
  workspace: string
  authors: Record<string, WorkAuthor>
  onNavigate: () => void
  personal?: boolean
}) {
  const t = useTranslations('workPanel')
  const { openRuntime } = useInfraPanel()
  const idle = lane.running.length === 0 && lane.queued.length === 0 && lane.upcoming.length === 0
  const Icon = personal ? Laptop : Server
  // Lane header click = the in-panel runtime/runner drill-in (the panel navigates itself, never the left half).
  const drillIn = lane.registered
    ? () => openRuntime('runtime', lane.runtime)
    : lane.runtime.startsWith('self:')
      ? () => openRuntime('runner', lane.runtime.slice('self:'.length))
      : undefined
  return (
    <div className={cn('rounded-lg border bg-card p-2.5', idle && 'opacity-60')}>
      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
        <Icon className="size-3.5 shrink-0 text-[#6ec6a8]" />
        {drillIn ? (
          <button
            type="button"
            onClick={drillIn}
            className="truncate text-[12.5px] font-[560] hover:underline"
          >
            {laneLabel(lane, t)}
          </button>
        ) : (
          <span className="truncate text-[12.5px] font-[560]">{laneLabel(lane, t)}</span>
        )}
        <span className="shrink-0 text-[11px] text-faint">
          {t('laneStats', { running: lane.running.length, queued: lane.queued.length })}
        </span>
        {idle && (
          <Badge tone="neutral" className="ml-auto shrink-0">
            {t('idle')}
          </Badge>
        )}
      </div>

      {!idle && (
        <>
          {lane.admission && (
            <div className="mt-1.5">
              <Admission lane={lane} />
            </div>
          )}
          <div className="mt-2 space-y-2.5">
            <LaneSection title={t('upcoming')} count={lane.upcoming.length}>
              {lane.upcoming.map((u) => (
                <UpcomingRow key={`${u.scheduleId}-${u.at}`} upcoming={u} />
              ))}
            </LaneSection>
            <LaneSection title={t('queued')} count={lane.queued.length}>
              {lane.queued.map((i, idx) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  workspace={workspace}
                  authors={authors}
                  onNavigate={onNavigate}
                  next={idx === 0}
                />
              ))}
            </LaneSection>
            <LaneSection title={t('running')} count={lane.running.length}>
              {lane.running.map((i) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  workspace={workspace}
                  authors={authors}
                  onNavigate={onNavigate}
                />
              ))}
            </LaneSection>
          </div>
        </>
      )}
    </div>
  )
}

// Lane group (workspace-shared / personal self-hosted) — active lanes first, idle lanes below.
function LaneGroup({
  title,
  lanes,
  workspace,
  authors,
  onNavigate,
  personal,
  emptyHint,
}: {
  title: string
  lanes: QueueLane[]
  workspace: string
  authors: Record<string, WorkAuthor>
  onNavigate: () => void
  personal?: boolean
  emptyHint?: React.ReactNode
}) {
  const busy = lanes.filter((l) => l.running.length + l.queued.length + l.upcoming.length > 0)
  const idle = lanes.filter((l) => l.running.length + l.queued.length + l.upcoming.length === 0)
  const ordered = [...busy, ...idle]
  return (
    <section className="space-y-1.5">
      <h3 className="text-[12px] font-[560] tracking-[-0.01em] text-secondary-foreground">
        {title}
      </h3>
      {lanes.length === 0 ? (
        emptyHint
      ) : (
        <div className="space-y-1.5">
          {ordered.map((lane) => (
            <LaneCard
              key={lane.runtime}
              lane={lane}
              workspace={workspace}
              authors={authors}
              onNavigate={onNavigate}
              {...(personal ? { personal } : {})}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// Top summary stats (running/queued/upcoming) — compact for the panel.
function Totals({ totals }: { totals: QueueSnapshot['totals'] }) {
  const t = useTranslations('workPanel')
  const cells: Array<{ label: string; value: number; primary?: boolean }> = [
    { label: t('running'), value: totals.running, primary: totals.running > 0 },
    { label: t('queued'), value: totals.queued },
    { label: t('upcoming'), value: totals.upcoming },
  ]
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {cells.map((c) => (
        <div key={c.label} className="rounded-md border bg-card px-2.5 py-2">
          <div className="text-[10px] font-[510] uppercase tracking-wide text-faint">{c.label}</div>
          <div
            className={cn(
              'mt-0.5 font-mono text-lg font-[560] leading-none tabular-nums',
              c.primary ? 'text-[var(--color-link)]' : 'text-foreground'
            )}
          >
            {c.value}
          </div>
        </div>
      ))}
    </div>
  )
}

export function WorkTab({ onNavigate }: { onNavigate: () => void }) {
  const t = useTranslations('workPanel')
  const { snapshot, authors, workspace, openTab } = useInfraPanel()

  const active = (snapshot?.totals.running ?? 0) + (snapshot?.totals.queued ?? 0)

  if (!snapshot)
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-faint">
        <Loader2 className="size-3.5 animate-spin" /> {t('loading')}
      </div>
    )

  return (
    <div className="space-y-4 px-3.5 py-3.5">
      <Totals totals={snapshot.totals} />

      {/* Orchestrator headline — how much the control-plane scheduler is admitting right now (in-flight/queued/quota). */}
      {snapshot.scheduler && (
        <div className="flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-2 font-mono text-[11px] tabular-nums text-muted-foreground">
          <ChevronsRight className="size-3.5 shrink-0 text-primary/60" />
          <span>
            {t('schedulerLine', {
              inFlight: snapshot.scheduler.inFlight,
              queued: snapshot.scheduler.queued,
            })}
          </span>
          {snapshot.scheduler.quota !== undefined && (
            <span className="text-faint">
              {t('schedulerQuota', { quota: snapshot.scheduler.quota })}
            </span>
          )}
        </div>
      )}

      {active === 0 && snapshot.totals.upcoming === 0 ? (
        <p className="py-6 text-center text-[12.5px] text-faint">{t('empty')}</p>
      ) : (
        <>
          <LaneGroup
            title={t('workspaceQueue')}
            lanes={snapshot.workspace}
            workspace={workspace}
            authors={authors}
            onNavigate={onNavigate}
          />
          <LaneGroup
            title={t('personalQueue')}
            lanes={snapshot.personal}
            workspace={workspace}
            authors={authors}
            onNavigate={onNavigate}
            personal
            emptyHint={
              <p className="text-[11.5px] text-faint">
                {t.rich('personalEmpty', {
                  link: (chunks) => (
                    // 인프라 링크는 왼쪽 라우터가 아니라 패널 안 런타임 탭으로 — 좌우 내비게이션 독립.
                    <button
                      type="button"
                      onClick={() => openTab('runtimes')}
                      className="text-link hover:underline"
                    >
                      {chunks}
                    </button>
                  ),
                })}
              </p>
            }
          />
        </>
      )}
    </div>
  )
}
