'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CirclePause, CirclePlay, Pause, Pencil, Play, Server, Trash2 } from 'lucide-react'

import type { Schedule } from '@/entities/schedule'
import { describeCron, fireDayLabel, fireTimeLabel } from '@/shared/lib/cron'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { EntityRef } from '@/shared/ui/chip'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { Tooltip } from '@/shared/ui/tooltip'

export type Author = { name: string; avatarUrl?: string }

export const RUNTIME_DEFAULT = '기본 백엔드'

export function runtimeLabelOf(s: Schedule): string {
  return s.runTemplate.runtime ?? RUNTIME_DEFAULT
}

export function ownerNameOf(authors: Record<string, Author>, subject: string): string {
  return authors[subject]?.name ?? fmtSubject(subject)
}

// 런타임 칩 — 발사가 도는 실행 인프라(런타임 미지정이면 '기본 백엔드'). 아이콘(Server)으로 종류 구별.
export function RuntimeChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      <Server className="size-3 shrink-0 text-[#6ec6a8]" />
      {label}
    </span>
  )
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

const stateTip = (enabled: boolean): string =>
  enabled ? '활성 — 주기대로 발사돼요' : '일시중지 — 발사하지 않아요'

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
            title="데이터셋(벤치마크) 상세"
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
              title="하니스 상세"
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
                  title="런타임 상세"
                >
                  <RuntimeChip label={runtimeLabelOf(s)} />
                </Link>
              ) : (
                <RuntimeChip label={runtimeLabelOf(s)} />
              )}
            </span>
          </span>
        </div>
        {/* ③ 주기 · 다음 실행 · 최근 상태 */}
        <div className="flex items-center gap-x-2 overflow-hidden whitespace-nowrap text-[12px] text-muted-foreground">
          <span className="shrink-0 font-[510] text-foreground/90">{describeCron(s.cron)}</span>
          <span className="hidden shrink-0 text-faint sm:inline">{s.timezone}</span>
          {s.enabled ? (
            next ? (
              <span className="truncate" title={fmtDateTimeFull(next)}>
                다음 실행 {fireDayLabel(next, nowIso, s.timezone)} {fireTimeLabel(next, s.timezone)}
                {approx ? <span className="text-faint"> (예상)</span> : null}
              </span>
            ) : (
              <span className="truncate text-faint">다음 실행 시각 계산 불가</span>
            )
          ) : (
            <span className="truncate text-faint">일시중지됨 — 발사 안 함</span>
          )}
          {s.lastStatus ? (
            <span className="hidden truncate text-faint lg:inline">
              · 최근 {s.lastStatus}
              {s.lastFiredAt ? ` (${fmtDateTime(s.lastFiredAt)})` : ''}
            </span>
          ) : null}
        </div>
      </div>
      {/* 우: 고정 슬롯 — 소유자 썸네일 · 상태 아이콘(툴팁 + 클릭=작업 드롭다운). 카드마다 같은 위치. */}
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="flex w-7 justify-center">
          <UserAvatar
            name={`${ownerNameOf(authors, s.createdBy)}${s.createdBy === me ? ' (나)' : ''}`}
            url={authors[s.createdBy]?.avatarUrl}
            label="소유자"
          />
        </span>
        <span className="flex w-8 justify-center">
          {canWrite ? (
            <DropdownMenu
              align="end"
              trigger={({ open, toggle }) => (
                <Tooltip content={stateTip(s.enabled)} align="end">
                  <button
                    type="button"
                    onClick={toggle}
                    disabled={pending}
                    aria-label={`상태: ${s.enabled ? '활성' : '일시중지'} — 작업 메뉴`}
                    aria-expanded={open}
                    className="grid size-8 place-items-center rounded-md transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    <StateIcon enabled={s.enabled} />
                  </button>
                </Tooltip>
              )}
            >
              <DropdownItem icon={s.enabled ? <Pause /> : <Play />} onSelect={() => onToggle(s)}>
                {s.enabled ? '일시중지' : '재개'}
              </DropdownItem>
              {canEdit ? (
                <DropdownItem
                  icon={<Pencil />}
                  onSelect={() =>
                    router.push(`/${workspace}/schedules/${encodeURIComponent(s.id)}/edit`)
                  }
                >
                  수정
                </DropdownItem>
              ) : null}
              <DropdownSeparator />
              <DropdownItem icon={<Trash2 />} tone="danger" onSelect={() => onDelete(s)}>
                삭제
              </DropdownItem>
            </DropdownMenu>
          ) : (
            <Tooltip content={stateTip(s.enabled)} align="end">
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
