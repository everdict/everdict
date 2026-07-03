'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, Search, Server } from 'lucide-react'

import type { Schedule } from '@/entities/schedule'
import { describeCron, fireDayLabel, fireTimeLabel } from '@/shared/lib/cron'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EntityRef } from '@/shared/ui/chip'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { StatCard } from '@/shared/ui/stat-card'

import { deleteScheduleAction, setScheduleEnabledAction } from '../api/schedule-actions'

type Author = { name: string; avatarUrl?: string }

const STATUS_OPTIONS = [
  { value: '', label: '전체 상태' },
  { value: 'enabled', label: '활성' },
  { value: 'paused', label: '일시중지' },
]

const RUNTIME_DEFAULT = '기본 백엔드'
const UPCOMING_HORIZON_DAYS = 7
const UPCOMING_LIMIT = 24

function runtimeLabelOf(s: Schedule): string {
  return s.runTemplate.runtime ?? RUNTIME_DEFAULT
}

// 런타임 칩 — 발사가 도는 실행 인프라(런타임 미지정이면 '기본 백엔드'). 하니스/벤치마크 칩과 동일 밀도.
function RuntimeChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      <Server className="size-3" />
      {label}
    </span>
  )
}

// 예약 목록 — 한 워크스페이스의 여러 사용자 크론잡을 소유자·런타임·벤치마크→하니스와 함께 한눈에.
// 소유자·상태·런타임 필터 + '다가오는 실행' 타임라인. 발사 자체는 컨트롤플레인(Temporal)이 한다.
export function ScheduleList({
  schedules,
  authors,
  fires,
  nowIso,
  me,
  canWrite,
}: {
  schedules: Schedule[]
  authors: Record<string, Author>
  fires: Record<string, string[]> // 예약 id → 다음 발사 시각(ISO, 서버 계산). 일시중지면 빈 배열.
  nowIso: string // 서버 기준 now — 상대 날짜 라벨을 서버/클라 동일하게(hydration 안전).
  me: string // 현재 사용자 subject — 소유자 필터에서 '(나)' 표기.
  canWrite: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState('') // 소유자(createdBy) 필터
  const [status, setStatus] = useState('') // '' | 'enabled' | 'paused'
  const [runtime, setRuntime] = useState('') // 런타임 필터

  function act(fn: () => Promise<{ ok: boolean; error?: string }>): void {
    setError(undefined)
    startTransition(async () => {
      const res = await fn()
      if (res.ok) router.refresh()
      else setError(res.error ?? '작업 실패')
    })
  }

  const ownerName = (sub: string) => authors[sub]?.name ?? fmtSubject(sub)

  const total = schedules.length
  const enabledCount = schedules.filter((s) => s.enabled).length
  const ownerCount = new Set(schedules.map((s) => s.createdBy)).size

  const ownerOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of schedules) m.set(s.createdBy, ownerName(s.createdBy))
    return [
      { value: '', label: '전체 소유자' },
      ...[...m.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([sub, name]) => ({ value: sub, label: sub === me ? `${name} (나)` : name })),
    ]
  }, [schedules, authors, me])

  const runtimeOptions = useMemo(() => {
    const s = new Set(schedules.map(runtimeLabelOf))
    return [{ value: '', label: '전체 런타임' }, ...[...s].sort().map((r) => ({ value: r, label: r }))]
  }, [schedules])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return schedules
      .filter((s) => {
        if (owner && s.createdBy !== owner) return false
        if (status === 'enabled' && !s.enabled) return false
        if (status === 'paused' && s.enabled) return false
        if (runtime && runtimeLabelOf(s) !== runtime) return false
        if (!q) return true
        const hay = [
          s.name,
          s.cron,
          describeCron(s.cron),
          s.runTemplate.dataset.id,
          s.runTemplate.harness.id,
          runtimeLabelOf(s),
          ownerName(s.createdBy),
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [schedules, authors, query, owner, status, runtime])

  // 다가오는 실행 — 보이는(필터 반영) 활성 예약들의 발사 시각을 병합·정렬. 7일 창, 상위 N건.
  const upcoming = useMemo(() => {
    const horizonMs = new Date(nowIso).getTime() + UPCOMING_HORIZON_DAYS * 86_400_000
    const rows: { iso: string; schedule: Schedule }[] = []
    for (const s of visible) {
      if (!s.enabled) continue
      for (const iso of fires[s.id] ?? []) {
        if (new Date(iso).getTime() <= horizonMs) rows.push({ iso, schedule: s })
      }
    }
    rows.sort((a, b) => a.iso.localeCompare(b.iso))
    return rows.slice(0, UPCOMING_LIMIT)
  }, [visible, fires, nowIso])

  return (
    <div className="space-y-5">
      {error && <Callout tone="danger">{error}</Callout>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="전체" value={total} />
        <StatCard label="활성" value={enabledCount} tone={enabledCount > 0 ? 'success' : 'default'} />
        <StatCard label="일시중지" value={total - enabledCount} />
        <StatCard label="소유자" value={ownerCount} hint={`${ownerCount}명이 등록`} />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름 · 주기 · 벤치마크 · 하니스 · 소유자로 검색"
            className="pl-8"
            aria-label="예약 검색"
          />
        </div>
        {ownerOptions.length > 2 && (
          <Combobox
            options={ownerOptions}
            value={owner}
            onChange={setOwner}
            placeholder="소유자"
            className="w-[160px]"
          />
        )}
        <Combobox
          options={STATUS_OPTIONS}
          value={status}
          onChange={setStatus}
          placeholder="상태"
          className="w-[130px]"
          searchable={false}
        />
        {runtimeOptions.length > 2 && (
          <Combobox
            options={runtimeOptions}
            value={runtime}
            onChange={setRuntime}
            placeholder="런타임"
            className="w-[150px]"
          />
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title="조건에 맞는 예약이 없습니다."
          hint="검색어나 필터를 바꿔보세요."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((s) => {
            const next = (fires[s.id] ?? [])[0]
            return (
              <div
                key={s.id}
                className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-lg border bg-card p-3.5 shadow-raise"
              >
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-[510] text-[14px]">{s.name}</span>
                    <Badge tone={s.enabled ? 'success' : 'neutral'}>
                      {s.enabled ? '활성' : '일시중지'}
                    </Badge>
                    <span
                      className="flex items-center gap-1.5"
                      title={`소유자 ${ownerName(s.createdBy)}`}
                    >
                      <Avatar name={ownerName(s.createdBy)} url={authors[s.createdBy]?.avatarUrl} size="sm" />
                      <span className="max-w-[140px] truncate text-[11.5px] text-muted-foreground">
                        {ownerName(s.createdBy)}
                        {s.createdBy === me ? ' (나)' : ''}
                      </span>
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                    <span className="font-[510] text-foreground/90">{describeCron(s.cron)}</span>
                    <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground">
                      {s.cron}
                    </code>
                    <span className="text-faint">{s.timezone}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]">
                    <EntityRef id={s.runTemplate.dataset.id} version={s.runTemplate.dataset.version} />
                    <span className="text-faint">→</span>
                    <EntityRef id={s.runTemplate.harness.id} version={s.runTemplate.harness.version} />
                    <RuntimeChip label={runtimeLabelOf(s)} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-1 text-[12px] text-muted-foreground">
                    {s.enabled ? (
                      next ? (
                        <span title={fmtDateTimeFull(next)}>
                          다음 실행 {fireDayLabel(next, nowIso, s.timezone)}{' '}
                          {fireTimeLabel(next, s.timezone)}
                        </span>
                      ) : (
                        <span className="text-faint">다음 실행 시각 계산 불가</span>
                      )
                    ) : (
                      <span className="text-faint">일시중지됨 — 발사 안 함</span>
                    )}
                    {s.lastStatus ? (
                      <span className="text-faint">
                        · 최근 {s.lastStatus}
                        {s.lastFiredAt ? ` (${fmtDateTime(s.lastFiredAt)})` : ''}
                      </span>
                    ) : null}
                  </div>
                </div>
                {canWrite ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => act(() => setScheduleEnabledAction(s.id, !s.enabled))}
                    >
                      {s.enabled ? '일시중지' : '재개'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => act(() => deleteScheduleAction(s.id))}
                    >
                      삭제
                    </Button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      <section className="space-y-2.5 rounded-lg border bg-card/60 p-4">
        <div className="flex items-center gap-2 text-[12px] font-[510] uppercase tracking-wide text-faint">
          <CalendarClock className="size-3.5" />
          다가오는 실행 · 이후 {UPCOMING_HORIZON_DAYS}일
        </div>
        {upcoming.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            예정된 실행이 없습니다(활성 예약이 없거나 이 기간에 발사가 없음).
          </p>
        ) : (
          <div className="space-y-0.5">
            {upcoming.map(({ iso, schedule }, i) => (
              <div
                key={`${schedule.id}-${iso}-${i}`}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px] hover:bg-elevated"
              >
                <span
                  className="w-[112px] shrink-0 font-mono tabular-nums text-muted-foreground"
                  title={fmtDateTimeFull(iso)}
                >
                  {fireDayLabel(iso, nowIso, schedule.timezone)}{' '}
                  <span className="text-foreground">{fireTimeLabel(iso, schedule.timezone)}</span>
                </span>
                <span className="min-w-0 flex-1 truncate font-[510]">{schedule.name}</span>
                <span
                  className="flex shrink-0 items-center gap-1.5 text-muted-foreground"
                  title={`소유자 ${ownerName(schedule.createdBy)}`}
                >
                  <Avatar
                    name={ownerName(schedule.createdBy)}
                    url={authors[schedule.createdBy]?.avatarUrl}
                    size="sm"
                  />
                  <span className="max-w-[120px] truncate text-[11.5px]">
                    {ownerName(schedule.createdBy)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
