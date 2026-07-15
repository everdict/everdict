'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Activity,
  CalendarClock,
  ChevronsRight,
  CircleDashed,
  Laptop,
  Loader2,
  Server,
  X,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import { membersSchema } from '@/entities/member'
import {
  queueSnapshotSchema,
  type QueueItem,
  type QueueLane,
  type QueueSnapshot,
} from '@/entities/queue'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { UserAvatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { EntityRef } from '@/shared/ui/chip'

// 작업 패널 — 오케스트레이터가 "지금 어떤 작업을 어디(런타임 레인)에서 얼마나 throughput 있게 굴리는지"를
// 오른쪽에서 슬라이드로 열어 보는 라이브 위젯. GET /queue(BFF /api/queue) 를 클라이언트 폴링(닫힘 느리게/열림 빠르게).
// docs/architecture/work-queue.md 의 스냅샷을 세로형으로 재구성 — 상단 요약 + 스케줄러 admission + 레인별 흐름.

type Author = { name: string; avatarUrl?: string }
type Translate = ReturnType<typeof useTranslations<'workPanel'>>

const POLL_OPEN_MS = 4_000 // 열려 있을 때 — 라이브 진행률
const POLL_CLOSED_MS = 20_000 // 닫혀 있을 때 — 트리거 배지 최신화만

// 레인 라벨 — 서버가 준 라벨(러너 호스트명) 우선. '' = 기본 백엔드.
function laneLabel(lane: QueueLane, t: Translate): string {
  if (lane.label) return lane.label
  if (lane.runtime === '') return t('defaultBackend')
  if (lane.runtime.startsWith('self:')) return lane.runtime.slice('self:'.length)
  return lane.runtime
}

// 배치 진행률 — total 이 있으면 막대 + n/total, 없으면 완료/실행 개수 텍스트.
function Progress({ progress }: { progress: NonNullable<QueueItem['progress']> }) {
  const t = useTranslations('workPanel')
  const { done, active, total } = progress
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
      </span>
    )
  }
  return (
    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
      {t('doneRunning', { done, active })}
    </span>
  )
}

// 작업 아이템 — 고정 포맷 한 줄: dataset→harness + 진행률/상태 + 실행자·시각. 클릭 = 상세로 이동(드로어 닫힘).
function ItemRow({
  item,
  workspace,
  authors,
  onNavigate,
  next,
}: {
  item: QueueItem
  workspace: string
  authors: Record<string, Author>
  onNavigate: () => void
  next?: boolean
}) {
  const t = useTranslations('workPanel')
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
      onClick={onNavigate}
      className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 transition-colors hover:border-border-strong hover:bg-elevated"
    >
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
    </Link>
  )
}

// 레인 안 하위 섹션(실행 중 / 대기 / 예약) — 제목 + 개수, 비어 있으면 렌더하지 않음(빈 섹션 숨김 규칙).
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

// 스케줄러 admission 유틸라이제이션 — in-flight vs 선언 슬롯(maxConcurrent) 막대 + mem/cpu 예산 + 서킷 상태.
function Admission({ lane }: { lane: QueueLane }) {
  const t = useTranslations('workPanel')
  const a = lane.admission
  if (!a) return null
  const max = a.maxConcurrent
  const slots = max !== undefined && max > 0 ? max : undefined // 선언 슬롯(narrow)
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

// 런타임 레인 카드 — 헤더(아이콘·라벨·통계·admission) + 흐름(예약 ⇢ 대기 ⇢ 실행). 유휴는 접어서 흐리게.
function LaneCard({
  lane,
  workspace,
  authors,
  onNavigate,
  personal,
}: {
  lane: QueueLane
  workspace: string
  authors: Record<string, Author>
  onNavigate: () => void
  personal?: boolean
}) {
  const t = useTranslations('workPanel')
  const idle = lane.running.length === 0 && lane.queued.length === 0 && lane.upcoming.length === 0
  const Icon = personal ? Laptop : Server
  return (
    <div className={cn('rounded-lg border bg-card p-2.5', idle && 'opacity-60')}>
      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
        <Icon className="size-3.5 shrink-0 text-[#6ec6a8]" />
        {lane.registered ? (
          <Link
            href={`/${workspace}/runtimes/${encodeURIComponent(lane.runtime)}`}
            onClick={onNavigate}
            className="truncate text-[12.5px] font-[560] hover:underline"
          >
            {laneLabel(lane, t)}
          </Link>
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
                <Link
                  key={`${u.scheduleId}-${u.at}`}
                  href={`/${workspace}/schedules`}
                  onClick={onNavigate}
                  className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 transition-colors hover:border-border-strong hover:bg-elevated"
                >
                  <CalendarClock className="size-3.5 shrink-0 text-faint" />
                  <div className="min-w-0 flex-1 space-y-0.5 overflow-hidden whitespace-nowrap">
                    <div className="truncate text-[12px] font-[510]">{u.name}</div>
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

// 레인 그룹(워크스페이스 공유 / 개인 셀프호스티드) — 활성 레인 먼저, 유휴 레인 아래.
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
  authors: Record<string, Author>
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

// 상단 요약 통계(실행/대기/예약) — 드로어용 소형.
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

export function WorkPanel({ workspace }: { workspace: string }) {
  const t = useTranslations('workPanel')
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null)
  const [authors, setAuthors] = useState<Record<string, Author>>({})
  const authorsLoaded = useRef(false)

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/queue', { cache: 'no-store' })
      if (!res.ok) return
      const parsed = queueSnapshotSchema.safeParse(await res.json())
      if (parsed.success) setSnapshot(parsed.data)
    } catch {
      // 폴링 실패는 조용히 — 다음 주기에 재시도.
    }
  }, [])

  // 폴링 — 마운트 시 + open 변화 시 즉시 1회, 이후 주기적(열림 빠르게/닫힘 느리게). 탭 숨김 시 스킵.
  useEffect(() => {
    void poll()
    const timer = setInterval(
      () => {
        if (typeof document !== 'undefined' && document.hidden) return
        void poll()
      },
      open ? POLL_OPEN_MS : POLL_CLOSED_MS
    )
    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [poll, open])

  // 작성자(이름/아바타) — 드로어 최초 오픈 시에만 lazy 로딩(모든 페이지에 멤버 조회를 얹지 않기 위함).
  useEffect(() => {
    if (!open || authorsLoaded.current) return
    authorsLoaded.current = true
    void (async () => {
      try {
        const res = await fetch('/api/members', { cache: 'no-store' })
        if (!res.ok) return
        const parsed = membersSchema.safeParse(await res.json())
        if (!parsed.success) return
        const map: Record<string, Author> = {}
        for (const m of parsed.data)
          map[m.subject] = {
            name: m.name ?? m.email?.split('@')[0] ?? m.subject,
            ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
          }
        setAuthors(map)
      } catch {
        // 작성자 보강 실패는 무시 — subject 폴백으로 표시.
      }
    })()
  }, [open])

  // Esc 로 닫기.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const active = (snapshot?.totals.running ?? 0) + (snapshot?.totals.queued ?? 0)
  const close = () => setOpen(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('trigger', { active })}
        className={cn(
          'relative grid size-8 place-items-center rounded-md transition-colors',
          open
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        <Activity className={cn('size-[18px]', active > 0 && 'text-primary')} strokeWidth={1.75} />
        {active > 0 && (
          <span className="absolute -right-1 -top-1 grid min-w-[15px] place-items-center rounded-full bg-primary px-1 text-[10px] font-[560] leading-[15px] text-primary-foreground">
            {active > 9 ? '9+' : active}
          </span>
        )}
      </button>

      {/* 백드롭 — 항상 마운트, open 에 따라 페이드. */}
      <div
        aria-hidden
        onClick={close}
        className={cn(
          'fixed inset-0 z-[55] bg-black/40 backdrop-blur-[1px] transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      />

      {/* 드로어 — 오른쪽 끝에서 슬라이드. 데스크톱 셸(Electron)에선 타이틀바 아래에서 시작(--titlebar-h). */}
      <aside
        aria-label={t('title')}
        style={{ top: 'var(--titlebar-h)', height: 'calc(100dvh - var(--titlebar-h))' }}
        className={cn(
          'fixed right-0 z-[60] flex w-[min(420px,100vw)] flex-col border-l border-border bg-background shadow-pop transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'pointer-events-none translate-x-full'
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-primary" strokeWidth={1.75} />
            <h2 className="text-[14px] font-[560] tracking-[-0.01em]">{t('title')}</h2>
          </div>
          <button
            type="button"
            aria-label={t('close')}
            onClick={close}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3.5 py-3.5">
          {snapshot ? (
            <>
              <Totals totals={snapshot.totals} />

              {/* 오케스트레이터 헤드라인 — 컨트롤플레인 스케줄러가 지금 얼마나 받아들이는지(진행/대기/쿼터). */}
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
                    onNavigate={close}
                  />
                  <LaneGroup
                    title={t('personalQueue')}
                    lanes={snapshot.personal}
                    workspace={workspace}
                    authors={authors}
                    onNavigate={close}
                    personal
                    emptyHint={
                      <p className="text-[11.5px] text-faint">
                        {t.rich('personalEmpty', {
                          link: (chunks) => (
                            <Link
                              href={`/${workspace}/runtimes`}
                              onClick={close}
                              className="text-link hover:underline"
                            >
                              {chunks}
                            </Link>
                          ),
                        })}
                      </p>
                    }
                  />
                </>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-faint">
              <Loader2 className="size-3.5 animate-spin" /> {t('loading')}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
