'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, Search } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { Schedule } from '@/entities/schedule'
import { describeCron, fireDayLabel, fireTimeLabel } from '@/shared/lib/cron'
import { fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { StatCard } from '@/shared/ui/stat-card'

import { deleteScheduleAction, setScheduleEnabledAction } from '../api/schedule-actions'
import { ScheduleCalendar } from './schedule-calendar'
import {
  ownerNameOf,
  runtimeChipLabel,
  runtimeLabelOf,
  ScheduleCard,
  type Author,
} from './schedule-card'

type View = 'list' | 'owner' | 'calendar'

const VIEWS: { value: View; labelKey: string }[] = [
  { value: 'list', labelKey: 'viewList' },
  { value: 'owner', labelKey: 'viewOwner' },
  { value: 'calendar', labelKey: 'viewCalendar' },
]

const UPCOMING_HORIZON_DAYS = 7
const UPCOMING_LIMIT = 24

// 예약 목록 — 한 워크스페이스의 여러 사용자 크론잡을 소유자·런타임·벤치마크→하니스와 함께.
// 뷰 전환(리스트 / 소유자별 / 캘린더) + 소유자·상태·런타임 필터 + '다가오는 실행' 타임라인.
// 발사 자체는 컨트롤플레인(Temporal)이 하고, 여기 시각은 표시용 근사(shared/lib/cron).
export function ScheduleList({
  schedules,
  authors,
  workspace,
  fires,
  nowIso,
  me,
  canWrite,
  isAdmin,
  initialView = 'list',
}: {
  schedules: Schedule[]
  authors: Record<string, Author>
  workspace: string // 데이터셋/하니스/수정 링크 prefix
  fires: Record<string, string[]> // 예약 id → 다음 발사 시각(ISO, 서버 계산). 일시중지면 빈 배열.
  nowIso: string // 서버 기준 now — 상대 날짜 라벨을 서버/클라 동일하게(hydration 안전).
  me: string // 현재 사용자 subject — 소유자 표기 + 수정 권한(생성자).
  canWrite: boolean // 일시중지/삭제(member+)
  isAdmin: boolean // 워크스페이스 admin — 남의 예약도 수정 가능
  initialView?: View // ?view= 로 초기 뷰 지정(딥링크). 이후 전환은 로컬 상태.
}) {
  const router = useRouter()
  const t = useTranslations('manageSchedules')
  const locale = useLocale()
  const statusOptions = [
    { value: '', label: t('statusAll') },
    { value: 'enabled', label: t('active') },
    { value: 'paused', label: t('paused') },
  ]
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [view, setView] = useState<View>(initialView)
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState('') // 소유자(createdBy) 필터
  const [status, setStatus] = useState('') // '' | 'enabled' | 'paused'
  const [runtime, setRuntime] = useState('') // 런타임 필터

  function act(fn: () => Promise<{ ok: boolean; error?: string }>): void {
    setError(undefined)
    startTransition(async () => {
      const res = await fn()
      if (res.ok) router.refresh()
      else setError(res.error ?? t('actionFailed'))
    })
  }
  const onToggle = (s: Schedule) => act(() => setScheduleEnabledAction(s.id, !s.enabled))
  const onDelete = (s: Schedule) => act(() => deleteScheduleAction(s.id))

  const total = schedules.length
  const enabledCount = schedules.filter((s) => s.enabled).length
  const ownerCount = new Set(schedules.map((s) => s.createdBy)).size

  const ownerOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of schedules) m.set(s.createdBy, ownerNameOf(authors, s.createdBy))
    return [
      { value: '', label: t('ownerAll') },
      ...[...m.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([sub, name]) => ({ value: sub, label: sub === me ? `${name} (${t('me')})` : name })),
    ]
  }, [schedules, authors, me, t])

  const runtimeOptions = useMemo(() => {
    const s = new Set(schedules.map(runtimeLabelOf))
    return [
      { value: '', label: t('runtimeAll') },
      ...[...s].sort().map((r) => ({ value: r, label: runtimeChipLabel(r, t) })),
    ]
  }, [schedules, t])

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
          describeCron(s.cron, locale),
          s.runTemplate.dataset.id,
          s.runTemplate.harness.id,
          runtimeLabelOf(s),
          ownerNameOf(authors, s.createdBy),
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [schedules, authors, query, owner, status, runtime, locale])

  // 소유자별 그룹(소유자 이름순) — visible 을 createdBy 로 묶는다.
  const ownerGroups = useMemo(() => {
    const m = new Map<string, Schedule[]>()
    for (const s of visible) m.set(s.createdBy, [...(m.get(s.createdBy) ?? []), s])
    return [...m.entries()].sort((a, b) =>
      ownerNameOf(authors, a[0]).localeCompare(ownerNameOf(authors, b[0]))
    )
  }, [visible, authors])

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

  const card = (s: Schedule) => (
    <ScheduleCard
      key={s.id}
      schedule={s}
      authors={authors}
      workspace={workspace}
      next={(fires[s.id] ?? [])[0]}
      approx={s.enabled && !(s.nextFireTimes && s.nextFireTimes.length > 0)}
      nowIso={nowIso}
      me={me}
      canWrite={canWrite}
      canEdit={s.createdBy === me || isAdmin}
      pending={pending}
      onToggle={onToggle}
      onDelete={onDelete}
    />
  )

  return (
    <div className="space-y-5">
      {error && <Callout tone="danger">{error}</Callout>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t('statTotal')} value={total} />
        <StatCard
          label={t('active')}
          value={enabledCount}
          tone={enabledCount > 0 ? 'success' : 'default'}
        />
        <StatCard label={t('paused')} value={total - enabledCount} />
        <StatCard
          label={t('statOwners')}
          value={ownerCount}
          hint={t('ownersHint', { count: ownerCount })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="inline-flex overflow-hidden rounded-lg border bg-card shadow-raise">
          {VIEWS.map((v, i) => (
            <button
              key={v.value}
              type="button"
              onClick={() => setView(v.value)}
              className={cn(
                'px-2.5 py-1.5 text-[12px] font-[510] transition-colors',
                i > 0 && 'border-l border-border',
                view === v.value
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(v.labelKey)}
            </button>
          ))}
        </div>
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
            aria-label={t('searchAria')}
          />
        </div>
        {ownerOptions.length > 2 && (
          <Combobox
            options={ownerOptions}
            value={owner}
            onChange={setOwner}
            placeholder={t('ownerPlaceholder')}
            className="w-[160px]"
          />
        )}
        <Combobox
          options={statusOptions}
          value={status}
          onChange={setStatus}
          placeholder={t('statusPlaceholder')}
          className="w-[130px]"
          searchable={false}
        />
        {runtimeOptions.length > 2 && (
          <Combobox
            options={runtimeOptions}
            value={runtime}
            onChange={setRuntime}
            placeholder={t('runtimePlaceholder')}
            className="w-[150px]"
          />
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={<Search />} title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : view === 'calendar' ? (
        <ScheduleCalendar schedules={visible} authors={authors} nowIso={nowIso} />
      ) : view === 'owner' ? (
        <div className="space-y-5">
          {ownerGroups.map(([subject, list]) => (
            <div key={subject} className="space-y-2">
              <div className="flex items-center gap-2 px-0.5">
                <Avatar
                  name={ownerNameOf(authors, subject)}
                  url={authors[subject]?.avatarUrl}
                  size="sm"
                />
                <span className="text-[13px] font-[560]">
                  {ownerNameOf(authors, subject)}
                  {subject === me ? ` (${t('me')})` : ''}
                </span>
                <span className="text-[12px] text-faint">
                  {t('countUnit', { count: list.length })}
                </span>
              </div>
              <div className="space-y-2">{list.map(card)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">{visible.map(card)}</div>
      )}

      {view !== 'calendar' && (
        <section className="space-y-2.5 rounded-lg border bg-card/60 p-4">
          <div className="flex items-center gap-2 text-[12px] font-[510] uppercase tracking-wide text-faint">
            <CalendarClock className="size-3.5" />
            {t('upcomingTitle', { days: UPCOMING_HORIZON_DAYS })}
          </div>
          {upcoming.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">{t('upcomingEmpty')}</p>
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
                    {fireDayLabel(iso, nowIso, schedule.timezone, locale)}{' '}
                    <span className="text-foreground">{fireTimeLabel(iso, schedule.timezone)}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-[510]">{schedule.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    <Avatar
                      name={ownerNameOf(authors, schedule.createdBy)}
                      url={authors[schedule.createdBy]?.avatarUrl}
                      size="sm"
                    />
                    <span className="max-w-[120px] truncate text-[11.5px]">
                      {ownerNameOf(authors, schedule.createdBy)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
