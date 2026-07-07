'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CirclePause, CirclePlay, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { Schedule } from '@/entities/schedule'
import { describeCron, fireDayLabel, fireTimeLabel } from '@/shared/lib/cron'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { EntityRef, RuntimeChip } from '@/shared/ui/chip'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { Tooltip } from '@/shared/ui/tooltip'

export type Author = { name: string; avatarUrl?: string }

// 런타임 미지정 시의 식별용 센티널 — 검색/필터 identity 로 쓰이므로 값은 고정. 표시는 runtimeChipLabel 이 로케일화.
export const RUNTIME_DEFAULT = '기본 백엔드'

export function runtimeLabelOf(s: Schedule): string {
  return s.runTemplate.runtime ?? RUNTIME_DEFAULT
}

// 런타임 칩 표시 라벨 — 센티널이면 로케일화, 실제 런타임 id 는 그대로.
export function runtimeChipLabel(label: string, t: ReturnType<typeof useTranslations>): string {
  return label === RUNTIME_DEFAULT ? t('runtimeDefault') : label
}

export function ownerNameOf(authors: Record<string, Author>, subject: string): string {
  return authors[subject]?.name ?? fmtSubject(subject)
}

// 상태 — 텍스트 배지 대신 색 있는 아이콘(활성=초록 재생, 일시중지=주황 일시정지) + 호버 툴팁.
// 클릭하면 상태별 작업 드롭다운(재개/일시중지·수정·삭제) — 상태 컨트롤 컨벤션(아이콘+드롭다운).
function StateIcon({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <CirclePlay className="size-[18px] text-[var(--color-success)]" />
  ) : (
    <CirclePause className="size-[18px] text-[var(--color-warning)]" />
  )
}

const stateTip = (enabled: boolean, t: ReturnType<typeof useTranslations>): string =>
  enabled ? t('stateTipActive') : t('stateTipPaused')

// 예약 한 건 — 소유자·상태·주기(사람이 읽는)·벤치마크→하니스·런타임·다음 실행 + pause/삭제.
export function ScheduleCard({
  schedule: s,
  authors,
  workspace,
  next,
  approx,
  nowIso,
  me,
  canWrite,
  canEdit,
  pending,
  onToggle,
  onDelete,
}: {
  schedule: Schedule
  authors: Record<string, Author>
  workspace: string // 데이터셋/하니스/수정 링크 prefix
  next: string | undefined // 다음 발사 시각(ISO) — 없거나 일시중지면 undefined
  approx: boolean // 다음 발사가 cron 근사(Temporal authoritative 아님)면 '(예상)' 표기
  nowIso: string
  me: string
  canWrite: boolean // 일시중지/삭제(member+)
  canEdit: boolean // 수정 = 생성자 또는 워크스페이스 admin
  pending: boolean
  onToggle: (s: Schedule) => void
  onDelete: (s: Schedule) => void
}) {
  const router = useRouter()
  const t = useTranslations('manageSchedules')
  const locale = useLocale()
  return (
    // 고정 규격 카드 — 모든 카드가 같은 3줄 구조(이름 / 대상 / 주기·다음 실행) + 우측 고정 슬롯.
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-3 shadow-raise">
      <div className="min-w-0 flex-1 space-y-1.5">
        {/* ① 이름 */}
        <div className="flex items-center overflow-hidden whitespace-nowrap text-[13px] font-[560]">
          <span className="truncate">{s.name}</span>
        </div>
        {/* ② 대상 — 아이콘으로 종류 구별(벤치마크=Database·하니스=Boxes·런타임=Server). 잘림 방지:
            좁은 화면은 벤치마크/하니스 각 한 줄(두 줄), md+ 는 한 줄. 화살표는 아이콘이 대신한다(스코어카드와 동일). */}
        <div className="flex flex-col gap-y-1 text-[12.5px] md:flex-row md:items-center md:gap-x-2.5">
          <Link
            href={`/${workspace}/datasets/${encodeURIComponent(s.runTemplate.dataset.id)}`}
            className="min-w-0 overflow-hidden whitespace-nowrap rounded-sm hover:text-foreground hover:underline"
            title={t('datasetDetail')}
          >
            <EntityRef
              id={s.runTemplate.dataset.id}
              version={s.runTemplate.dataset.version}
              kind="dataset"
            />
          </Link>
          <span className="flex min-w-0 items-center gap-x-2 overflow-hidden whitespace-nowrap">
            <Link
              href={`/${workspace}/harnesses/${encodeURIComponent(s.runTemplate.harness.id)}`}
              className="min-w-0 truncate rounded-sm hover:text-foreground hover:underline"
              title={t('harnessDetail')}
            >
              <EntityRef
                id={s.runTemplate.harness.id}
                version={s.runTemplate.harness.version}
                kind="harness"
              />
            </Link>
            <span className="hidden shrink-0 sm:inline-flex">
              {s.runTemplate.runtime && !s.runTemplate.runtime.startsWith('self:') ? (
                <Link
                  href={`/${workspace}/runtimes/${encodeURIComponent(s.runTemplate.runtime)}`}
                  className="rounded-sm hover:underline"
                  title={t('runtimeDetail')}
                >
                  <RuntimeChip label={runtimeChipLabel(runtimeLabelOf(s), t)} />
                </Link>
              ) : (
                <RuntimeChip label={runtimeChipLabel(runtimeLabelOf(s), t)} />
              )}
            </span>
          </span>
        </div>
        {/* ③ 주기 · 다음 실행 · 최근 상태 */}
        <div className="flex items-center gap-x-2 overflow-hidden whitespace-nowrap text-[12px] text-muted-foreground">
          <span className="shrink-0 font-[510] text-foreground/90">
            {describeCron(s.cron, locale)}
          </span>
          <span className="hidden shrink-0 text-faint sm:inline">{s.timezone}</span>
          {s.enabled ? (
            next ? (
              <span className="truncate" title={fmtDateTimeFull(next)}>
                {t('nextRunLabel')} {fireDayLabel(next, nowIso, s.timezone, locale)}{' '}
                {fireTimeLabel(next, s.timezone)}
                {approx ? <span className="text-faint"> {t('approxNote')}</span> : null}
              </span>
            ) : (
              <span className="truncate text-faint">{t('nextRunUnknown')}</span>
            )
          ) : (
            <span className="truncate text-faint">{t('pausedNoFire')}</span>
          )}
          {s.lastStatus ? (
            <span className="hidden truncate text-faint lg:inline">
              · {t('lastRun')} {s.lastStatus}
              {s.lastFiredAt ? ` (${fmtDateTime(s.lastFiredAt)})` : ''}
            </span>
          ) : null}
        </div>
      </div>
      {/* 우: 고정 슬롯 — 소유자 썸네일 · 상태 아이콘(툴팁 + 클릭=작업 드롭다운). 카드마다 같은 위치. */}
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="flex w-7 justify-center">
          <UserAvatar
            name={`${ownerNameOf(authors, s.createdBy)}${s.createdBy === me ? ` (${t('me')})` : ''}`}
            url={authors[s.createdBy]?.avatarUrl}
            label={t('ownerLabel')}
          />
        </span>
        <span className="flex w-8 justify-center">
          {canWrite ? (
            <DropdownMenu
              align="end"
              trigger={({ open, toggle }) => (
                <Tooltip content={stateTip(s.enabled, t)} align="end">
                  <button
                    type="button"
                    onClick={toggle}
                    disabled={pending}
                    aria-label={t('stateAria', { state: s.enabled ? t('active') : t('paused') })}
                    aria-expanded={open}
                    className="grid size-8 place-items-center rounded-md transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    <StateIcon enabled={s.enabled} />
                  </button>
                </Tooltip>
              )}
            >
              <DropdownItem icon={s.enabled ? <Pause /> : <Play />} onSelect={() => onToggle(s)}>
                {s.enabled ? t('pause') : t('resume')}
              </DropdownItem>
              {canEdit ? (
                <DropdownItem
                  icon={<Pencil />}
                  onSelect={() =>
                    router.push(`/${workspace}/schedules/${encodeURIComponent(s.id)}/edit`)
                  }
                >
                  {t('edit')}
                </DropdownItem>
              ) : null}
              <DropdownSeparator />
              <DropdownItem icon={<Trash2 />} tone="danger" onSelect={() => onDelete(s)}>
                {t('delete')}
              </DropdownItem>
            </DropdownMenu>
          ) : (
            <Tooltip content={stateTip(s.enabled, t)} align="end">
              <span className="grid size-8 place-items-center">
                <StateIcon enabled={s.enabled} />
              </span>
            </Tooltip>
          )}
        </span>
      </div>
    </div>
  )
}
