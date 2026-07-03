import Link from 'next/link'
import { CalendarClock, CircleDashed, Loader2, Server } from 'lucide-react'

import type { QueueItem, QueueLane, QueueSnapshot } from '@/entities/queue'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { UserAvatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'
import { EntityRef } from '@/shared/ui/chip'
import { StatCard } from '@/shared/ui/stat-card'

type Author = { name: string; avatarUrl?: string }

// 레인 라벨 — '' = 기본 백엔드, self:<id> = 셀프호스티드 러너.
function laneLabel(runtime: string): string {
  if (runtime === '') return '기본 백엔드'
  if (runtime.startsWith('self:')) return `내 러너 ${runtime.slice('self:'.length)}`
  return runtime
}

// 배치 진행률 — total 있으면 바+n/total, 없으면 완료/실행 카운트 텍스트.
function Progress({ progress }: { progress: NonNullable<QueueItem['progress']> }) {
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
        {active > 0 && <span className="shrink-0 text-[10.5px] text-faint">· 실행 {active}</span>}
      </span>
    )
  }
  return (
    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
      완료 {done} · 실행 {active}
    </span>
  )
}

// 큐 항목 — 고정 규격 한 줄: 대상(아이콘 EntityRef) + 진행률/케이스 + 실행자·시각.
function ItemRow({
  item,
  workspace,
  authors,
  next,
}: {
  item: QueueItem
  workspace: string
  authors: Record<string, Author>
  next?: boolean // 대기 큐 맨 앞(다음 작업) 표시
}) {
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
              다음
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
                <Loader2 className="size-3 animate-spin" /> 실행 중
              </span>
            )
          ) : (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-faint">
              <CircleDashed className="size-3" /> 대기
            </span>
          )}
          {item.trigger && (
            <span className="hidden text-[10.5px] text-faint md:inline">{item.trigger}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="flex w-5 justify-center">
          {author && <UserAvatar name={author.name} url={author.avatarUrl} label="실행자" />}
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

// 런타임 레인 — 실행 중 | 대기(FIFO) | 다음 예약 3열(모바일은 세로 스택).
function Lane({
  lane,
  workspace,
  authors,
}: {
  lane: QueueLane
  workspace: string
  authors: Record<string, Author>
}) {
  const idle = lane.running.length === 0 && lane.queued.length === 0 && lane.upcoming.length === 0
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
        <Server className="size-4 shrink-0 text-[#6ec6a8]" />
        {lane.registered ? (
          <Link
            href={`/${workspace}/runtimes/${encodeURIComponent(lane.runtime)}`}
            className="truncate text-[13.5px] font-[560] hover:underline"
          >
            {laneLabel(lane.runtime)}
          </Link>
        ) : (
          <span className="truncate text-[13.5px] font-[560]">{laneLabel(lane.runtime)}</span>
        )}
        <span className="shrink-0 text-[11.5px] text-faint">
          실행 {lane.running.length} · 대기 {lane.queued.length}
        </span>
        {idle && (
          <Badge tone="neutral" className="ml-auto shrink-0">
            유휴
          </Badge>
        )}
      </div>

      {!idle && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-1.5">
            <ColumnHeader title="실행 중" count={lane.running.length} />
            {lane.running.length === 0 ? (
              <EmptyColumn label="실행 중인 작업 없음" />
            ) : (
              lane.running.map((i) => (
                <ItemRow key={i.id} item={i} workspace={workspace} authors={authors} />
              ))
            )}
          </div>
          <div className="space-y-1.5">
            <ColumnHeader title="대기 (선입선출)" count={lane.queued.length} />
            {lane.queued.length === 0 ? (
              <EmptyColumn label="대기 중인 작업 없음" />
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
          <div className="space-y-1.5">
            <ColumnHeader title="다음 예약" count={lane.upcoming.length} />
            {lane.upcoming.length === 0 ? (
              <EmptyColumn label="예정된 발사 없음" />
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
        </div>
      )}
    </Card>
  )
}

// 작업 큐 보드 — 런타임 레인별 실행 중/대기/다음 예약. 유휴 레인은 접힌 헤더 한 줄로 유지(존재 자체가 정보).
export function QueueBoard({
  snapshot,
  workspace,
  authors,
}: {
  snapshot: QueueSnapshot
  workspace: string
  authors: Record<string, Author>
}) {
  const busyLanes = snapshot.lanes.filter(
    (l) => l.running.length + l.queued.length + l.upcoming.length > 0
  )
  const idleLanes = snapshot.lanes.filter(
    (l) => l.running.length + l.queued.length + l.upcoming.length === 0
  )
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="실행 중"
          value={snapshot.totals.running}
          tone={snapshot.totals.running > 0 ? 'primary' : 'default'}
        />
        <StatCard label="대기" value={snapshot.totals.queued} />
        <StatCard label="예정 발사" value={snapshot.totals.upcoming} />
        <StatCard label="런타임 레인" value={snapshot.lanes.length} />
      </div>

      <div className={cn('space-y-3')}>
        {busyLanes.map((lane) => (
          <Lane key={lane.runtime} lane={lane} workspace={workspace} authors={authors} />
        ))}
        {idleLanes.map((lane) => (
          <Lane key={lane.runtime} lane={lane} workspace={workspace} authors={authors} />
        ))}
      </div>
    </div>
  )
}
