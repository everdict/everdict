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

// Identity sentinel for when runtime is unset — used as search/filter identity, so the value is fixed. Display is localized by runtimeChipLabel.
export const RUNTIME_DEFAULT = '기본 백엔드'

export function runtimeLabelOf(s: Schedule): string {
  return s.runTemplate.runtime ?? RUNTIME_DEFAULT
}

// Runtime chip display label — localize the sentinel, leave a real runtime id as-is.
export function runtimeChipLabel(label: string, t: ReturnType<typeof useTranslations>): string {
  return label === RUNTIME_DEFAULT ? t('runtimeDefault') : label
}

export function ownerNameOf(authors: Record<string, Author>, subject: string): string {
  return authors[subject]?.name ?? fmtSubject(subject)
}

// State — a colored icon instead of a text badge (active = green play, paused = amber pause) + hover tooltip.
// Clicking opens a state-specific action dropdown (resume/pause · edit · delete) — the state-control convention (icon + dropdown).
function StateIcon({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <CirclePlay className="size-[18px] text-[var(--color-success)]" />
  ) : (
    <CirclePause className="size-[18px] text-[var(--color-warning)]" />
  )
}

const stateTip = (enabled: boolean, t: ReturnType<typeof useTranslations>): string =>
  enabled ? t('stateTipActive') : t('stateTipPaused')

// A single schedule — owner · state · cadence (human-readable) · benchmark→harness · runtime · next run + pause/delete.
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
  workspace: string // prefix for dataset/harness/edit links
  next: string | undefined // next fire time (ISO) — undefined if none or paused
  approx: boolean // if the next fire is a cron approximation (not Temporal-authoritative), mark it '(estimated)'
  nowIso: string
  me: string
  canWrite: boolean // pause/delete (member+)
  canEdit: boolean // edit = creator or workspace admin
  pending: boolean
  onToggle: (s: Schedule) => void
  onDelete: (s: Schedule) => void
}) {
  const router = useRouter()
  const t = useTranslations('manageSchedules')
  const locale = useLocale()
  return (
    // Fixed-format card — every card has the same 3-line structure (name / target / cadence · next run) + a fixed right-side slot.
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-3 shadow-raise">
      <div className="min-w-0 flex-1 space-y-1.5">
        {/* ① Name */}
        <div className="flex items-center overflow-hidden whitespace-nowrap text-[13px] font-[560]">
          <span className="truncate">{s.name}</span>
        </div>
        {/* ② Target — icons distinguish the kind (benchmark=Database · harness=Boxes · runtime=Server). Avoid clipping:
            on narrow screens benchmark/harness each get their own line (two lines), md+ is one line. Icons stand in for arrows (same as scorecards). */}
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
        {/* ③ Cadence · next run · latest status */}
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
      {/* Right: fixed slot — owner thumbnail · state icon (tooltip + click = action dropdown). Same position on every card. */}
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
