import Link from 'next/link'
import { CalendarClock, ChevronsRight, CircleDashed, Laptop, Loader2, Server } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { QueueItem, QueueLane, QueueSnapshot } from '@/entities/queue'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'
import { EntityRef } from '@/shared/ui/chip'
import { StatCard } from '@/shared/ui/stat-card'

type Author = { name: string; avatarUrl?: string }
type Translate = ReturnType<typeof useTranslations<'queueBoard'>>

// Lane label — prefer the server-provided label (runner hostname); '' = default backend.
function laneLabel(lane: QueueLane, t: Translate): string {
  if (lane.label) return lane.label
  if (lane.runtime === '') return t('defaultBackend')
  if (lane.runtime.startsWith('self:')) return lane.runtime.slice('self:'.length)
  return lane.runtime
}

// Batch progress — if total is present, a bar + n/total, otherwise a completed/running count text.
function Progress({ progress }: { progress: NonNullable<QueueItem['progress']> }) {
  const t = useTranslations('queueBoard')
  const { done, active, total } = progress
  if (total && total > 0) {
    const pct = Math.min(100, Math.round((done / total) * 100))
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted/60">
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
      </span>
    )
  }
  return (
    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
      {t('doneRunning', { done, active })}
    </span>
  )
}

// Queue item — a fixed-format single line: target (icon EntityRef) + progress/case + runner·time.
function ItemRow({
  item,
  workspace,
  authors,
  next,
}: {
  item: QueueItem
  workspace: string
  authors: Record<string, Author>
  next?: boolean // marks the front of the waiting queue (next job)
}) {
  const t = useTranslations('queueBoard')
  const href =
    item.type === 'scorecard'
      ? `/${workspace}/scorecards/${encodeURIComponent(item.id)}`
      : `/${workspace}/runs/${encodeURIComponent(item.id)}`
  const author = item.createdBy
    ? (authors[item.createdBy] ?? { name: fmtSubject(item.createdBy) })
    : undefined
  return (
    <Link
      href={href}
      className="flex h-[52px] items-center gap-2.5 rounded-md border bg-card px-2.5 transition-colors hover:border-border-strong hover:bg-elevated"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12.5px] font-[510]">
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
          {item.caseId && (
            <span className="hidden min-w-0 truncate font-mono text-[11px] text-faint sm:inline">
              {item.caseId}
            </span>
          )}
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
            <span className="hidden text-[10.5px] text-faint md:inline">{item.trigger}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="flex w-5 justify-center">
          {author && (
            <UserAvatar name={author.name} url={author.avatarUrl} label={t('runnerLabel')} />
          )}
        </span>
        <time
          className="hidden w-[76px] text-right font-mono text-[10.5px] text-muted-foreground sm:block"
          title={fmtDateTimeFull(item.createdAt)}
        >
          {fmtDateTime(item.createdAt)}
        </time>
      </div>
    </Link>
  )
}

function ColumnHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
      {title}
      <span className="tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}

function EmptyColumn({ label }: { label: string }) {
  return <p className="py-2 text-[11.5px] text-faint">{label}</p>
}

// Flow connector — visualizes the "flowing" direction scheduled ⇢ waiting ⇢ running (wide screens only).
function FlowConnector() {
  return (
    <div className="hidden items-center pt-6 lg:flex" aria-hidden>
      <ChevronsRight className="size-4 animate-pulse text-primary/50" />
    </div>
  )
}

// Runtime lane — left→right in flow order (next scheduled ⇢ waiting FIFO ⇢ running). Vertical stack on mobile.
function Lane({
  lane,
  workspace,
  authors,
  personal,
}: {
  lane: QueueLane
  workspace: string
  authors: Record<string, Author>
  personal?: boolean
}) {
  const t = useTranslations('queueBoard')
  const idle = lane.running.length === 0 && lane.queued.length === 0 && lane.upcoming.length === 0
  const Icon = personal ? Laptop : Server
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
        <Icon className="size-4 shrink-0 text-[#6ec6a8]" />
        {lane.registered ? (
          <Link
            href={`/${workspace}/runtimes/${encodeURIComponent(lane.runtime)}`}
            className="truncate text-[13.5px] font-[560] hover:underline"
          >
            {laneLabel(lane, t)}
          </Link>
        ) : (
          <span className="truncate text-[13.5px] font-[560]">{laneLabel(lane, t)}</span>
        )}
        <span className="shrink-0 text-[11.5px] text-faint">
          {t('laneStats', { running: lane.running.length, queued: lane.queued.length })}
        </span>
        {lane.admission?.memoryBudgetMb !== undefined && (
          <span
            className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground"
            title={t('admissionMemoryTitle')}
          >
            {t('admissionMemory', {
              used: lane.admission.memInFlightMb ?? 0,
              budget: lane.admission.memoryBudgetMb,
            })}
          </span>
        )}
        {lane.admission?.cpuBudget !== undefined && (
          <span
            className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground"
            title={t('admissionCpuTitle')}
          >
            {t('admissionCpu', {
              used: lane.admission.cpuInFlight ?? 0,
              budget: lane.admission.cpuBudget,
            })}
          </span>
        )}
        {lane.admission?.circuit?.open && (
          <Badge
            tone="danger"
            className="shrink-0"
            title={t('circuitOpenTitle', { n: lane.admission.circuit.consecutive })}
          >
            {t('circuitOpen')}
          </Badge>
        )}
        {idle && (
          <Badge tone="neutral" className="ml-auto shrink-0">
            {t('idle')}
          </Badge>
        )}
      </div>

      {!idle && (
        <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <div className="space-y-1.5">
            <ColumnHeader title={t('colUpcoming')} count={lane.upcoming.length} />
            {lane.upcoming.length === 0 ? (
              <EmptyColumn label={t('emptyUpcoming')} />
            ) : (
              lane.upcoming.map((u) => (
                <Link
                  key={`${u.scheduleId}-${u.at}`}
                  href={`/${workspace}/schedules`}
                  className="flex h-[52px] items-center gap-2.5 rounded-md border bg-card px-2.5 transition-colors hover:border-border-strong hover:bg-elevated"
                >
                  <CalendarClock className="size-3.5 shrink-0 text-faint" />
                  <div className="min-w-0 flex-1 space-y-1 overflow-hidden whitespace-nowrap">
                    <div className="truncate text-[12.5px] font-[510]">{u.name}</div>
                    <div className="truncate font-mono text-[10.5px] text-faint">
                      {u.dataset} → {u.harness}
                    </div>
                  </div>
                  <time
                    className="shrink-0 font-mono text-[10.5px] text-muted-foreground"
                    title={fmtDateTimeFull(u.at)}
                  >
                    {fmtDateTime(u.at)}
                  </time>
                </Link>
              ))
            )}
          </div>
          <FlowConnector />
          <div className="space-y-1.5">
            <ColumnHeader title={t('colQueued')} count={lane.queued.length} />
            {lane.queued.length === 0 ? (
              <EmptyColumn label={t('emptyQueued')} />
            ) : (
              lane.queued.map((i, idx) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  workspace={workspace}
                  authors={authors}
                  next={idx === 0}
                />
              ))
            )}
          </div>
          <FlowConnector />
          <div className="space-y-1.5">
            <ColumnHeader title={t('running')} count={lane.running.length} />
            {lane.running.length === 0 ? (
              <EmptyColumn label={t('emptyRunning')} />
            ) : (
              lane.running.map((i) => (
                <ItemRow key={i.id} item={i} workspace={workspace} authors={authors} />
              ))
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

// Lane group — the workspace queue (shared runtime) and my personal queue (self-hosted) are separate queues.
function LaneGroup({
  title,
  lanes,
  workspace,
  authors,
  personal,
  emptyHint,
}: {
  title: string
  lanes: QueueLane[]
  workspace: string
  authors: Record<string, Author>
  personal?: boolean
  emptyHint?: React.ReactNode
}) {
  // Active lanes first, idle lanes below.
  const busy = lanes.filter((l) => l.running.length + l.queued.length + l.upcoming.length > 0)
  const idle = lanes.filter((l) => l.running.length + l.queued.length + l.upcoming.length === 0)
  return (
    <section className="space-y-2.5">
      <h2 className="text-[14px] font-[560] tracking-[-0.01em] text-foreground">{title}</h2>
      {lanes.length === 0 ? (
        emptyHint
      ) : (
        <div className="space-y-3">
          {busy.map((lane) => (
            <Lane
              key={lane.runtime}
              lane={lane}
              workspace={workspace}
              authors={authors}
              {...(personal ? { personal } : {})}
            />
          ))}
          {idle.map((lane) => (
            <Lane
              key={lane.runtime}
              lane={lane}
              workspace={workspace}
              authors={authors}
              {...(personal ? { personal } : {})}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// Work-queue board — shows the workspace queue (request → shared runtime) and my personal queue (self-hosted) separately.
export function QueueBoard({
  snapshot,
  workspace,
  authors,
}: {
  snapshot: QueueSnapshot
  workspace: string
  authors: Record<string, Author>
}) {
  const t = useTranslations('queueBoard')
  return (
    <div className="space-y-7">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label={t('running')}
          value={snapshot.totals.running}
          tone={snapshot.totals.running > 0 ? 'primary' : 'default'}
        />
        <StatCard label={t('queued')} value={snapshot.totals.queued} />
        <StatCard label={t('upcomingLaunches')} value={snapshot.totals.upcoming} />
        <StatCard
          label={t('runtimeLanes')}
          value={snapshot.workspace.length + snapshot.personal.length}
        />
      </div>

      {snapshot.scheduler && (
        <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {t('schedulerLine', {
            queued: snapshot.scheduler.queued,
            inFlight: snapshot.scheduler.inFlight,
          })}
          {snapshot.scheduler.quota !== undefined && (
            <span className="text-faint">
              {' '}
              {t('schedulerQuotaSuffix', { quota: snapshot.scheduler.quota })}
            </span>
          )}
        </p>
      )}

      <LaneGroup
        title={t('workspaceQueue')}
        lanes={snapshot.workspace}
        workspace={workspace}
        authors={authors}
      />

      <LaneGroup
        title={t('personalQueue')}
        lanes={snapshot.personal}
        workspace={workspace}
        authors={authors}
        personal
        emptyHint={
          <p className="text-[12px] text-faint">
            {t.rich('personalEmpty', {
              link: (chunks) => (
                <Link href={`/${workspace}/runtimes`} className="text-link hover:underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        }
      />
    </div>
  )
}
