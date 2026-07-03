'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MoreHorizontal, Pause, Pencil, Play, Server, Trash2 } from 'lucide-react'

import type { Schedule } from '@/entities/schedule'
import { describeCron, fireDayLabel, fireTimeLabel } from '@/shared/lib/cron'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { EntityRef } from '@/shared/ui/chip'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'

export type Author = { name: string; avatarUrl?: string }

export const RUNTIME_DEFAULT = '기본 백엔드'

export function runtimeLabelOf(s: Schedule): string {
  return s.runTemplate.runtime ?? RUNTIME_DEFAULT
}

export function ownerNameOf(authors: Record<string, Author>, subject: string): string {
  return authors[subject]?.name ?? fmtSubject(subject)
}

// 런타임 칩 — 발사가 도는 실행 인프라(런타임 미지정이면 '기본 백엔드'). 하니스/벤치마크 칩과 동일 밀도.
export function RuntimeChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      <Server className="size-3" />
      {label}
    </span>
  )
}

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
    // 고정 규격 카드 — 스코어카드 목록과 동일(72px·좌 2줄·우 고정 슬롯). wrap 대신 truncate.
    <div className="flex h-[72px] items-center gap-3 rounded-lg border bg-card px-3.5 shadow-raise">
      <div className="min-w-0 flex-1 space-y-1.5">
        {/* ① 이름 · 벤치마크→하니스(+런타임 칩) */}
        <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] font-[510]">
          <span className="truncate">{s.name}</span>
          <span className="shrink-0 text-faint">·</span>
          <Link
            href={`/${workspace}/datasets/${encodeURIComponent(s.runTemplate.dataset.id)}`}
            className="truncate rounded-sm hover:text-foreground hover:underline"
            title="데이터셋(벤치마크) 상세"
          >
            <EntityRef id={s.runTemplate.dataset.id} version={s.runTemplate.dataset.version} />
          </Link>
          <span className="shrink-0 text-faint">→</span>
          <Link
            href={`/${workspace}/harnesses/${encodeURIComponent(s.runTemplate.harness.id)}`}
            className="truncate rounded-sm hover:text-foreground hover:underline"
            title="하니스 상세"
          >
            <EntityRef id={s.runTemplate.harness.id} version={s.runTemplate.harness.version} />
          </Link>
          <span className="hidden shrink-0 md:inline-flex">
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
        </div>
        {/* ② 주기 · 다음 실행 · 최근 상태 */}
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
      {/* 우: 고정 슬롯 — 소유자 썸네일 · 상태 배지 · 작업 메뉴. 카드마다 같은 위치. */}
      <div className="flex shrink-0 items-center gap-2.5">
        <span className="flex w-6 justify-center">
          <UserAvatar
            name={`${ownerNameOf(authors, s.createdBy)}${s.createdBy === me ? ' (나)' : ''}`}
            url={authors[s.createdBy]?.avatarUrl}
            label="소유자"
          />
        </span>
        <span className="flex w-[64px] justify-end">
          <Badge tone={s.enabled ? 'success' : 'neutral'}>{s.enabled ? '활성' : '일시중지'}</Badge>
        </span>
        <span className="flex w-8 justify-end">
          {canWrite ? (
            <DropdownMenu
              align="end"
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  disabled={pending}
                  aria-label="예약 작업"
                  aria-expanded={open}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              )}
            >
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
              <DropdownItem icon={s.enabled ? <Pause /> : <Play />} onSelect={() => onToggle(s)}>
                {s.enabled ? '일시중지' : '재개'}
              </DropdownItem>
              <DropdownSeparator />
              <DropdownItem icon={<Trash2 />} tone="danger" onSelect={() => onDelete(s)}>
                삭제
              </DropdownItem>
            </DropdownMenu>
          ) : null}
        </span>
      </div>
    </div>
  )
}
