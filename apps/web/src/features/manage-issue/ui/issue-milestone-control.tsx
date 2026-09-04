'use client'

import { useState } from 'react'
import { Check, ChevronDown, Flag, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'

import { updateIssueAction } from '../api/issues'

export interface IssueMilestoneOption {
  id: string
  name: string
  // The target date is shown alongside when there is one — half of deciding which checkpoint is "by when".
  targetDate?: string
}

// The project checkpoint an issue is attached to — attached and detached on the row directly under the project. A milestone means something
// only inside a project (the control plane judges "is this one of this issue's project's"), so this row does not appear at all on an issue
// with no project. The name is NOT a link — a checkpoint has no address of its own and lives only inside the project detail.
export function IssueMilestoneControl({
  id,
  milestone,
  milestones,
  canWrite,
}: {
  id: string
  milestone: IssueMilestoneOption | undefined
  // The checkpoints of the project this issue is in — another project's are refused by the control plane, so they never arrive here.
  milestones: IssueMilestoneOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [saving, setSaving] = useState(false)

  // What the SERVER accepted is this row's new truth — the same rule as the project control (see the `use-refresh` comment).
  const serverId = milestone?.id ?? null
  const [chosenId, setChosenId] = useState<string | null | undefined>(undefined)
  if (chosenId !== undefined && chosenId === serverId) setChosenId(undefined)
  const shownId = chosenId === undefined ? serverId : chosenId
  const shown =
    shownId === null ? undefined : (milestones.find((m) => m.id === shownId) ?? milestone)

  // `null` CLEARS it — it means detach from the checkpoint, and it must never be conflated with `undefined` (untouched).
  async function assign(milestoneId: string | null): Promise<void> {
    if (milestoneId === shownId) return
    setSaving(true)
    const r = await updateIssueAction(id, { milestoneId })
    setSaving(false)
    if (!r.ok) {
      toast.error(r.error ?? t('milestoneError'))
      return
    }
    setChosenId(milestoneId)
    refresh()
  }

  const chip = shown ? (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Flag className="size-3.5 shrink-0 text-faint" />
      <span className="truncate">{shown.name}</span>
      {shown.targetDate && (
        <time className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {shown.targetDate}
        </time>
      )}
    </span>
  ) : null

  if (!canWrite) return chip

  return (
    <div className="flex min-w-0 items-center gap-1">
      {chip}
      <DropdownMenu
        align="end"
        contentClassName="w-56 p-1"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('milestoneControlLabel')}
            disabled={saving}
            className={cn(
              'shrink-0 transition-colors disabled:opacity-50',
              shown
                ? 'inline-flex size-5 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground'
                : // On an issue not on any checkpoint yet, this button is the only affordance — that is the only time it wears a label.
                  'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:border-border-strong hover:bg-accent hover:text-foreground'
            )}
          >
            {saving ? (
              <Loader2 className="size-3 animate-spin" />
            ) : shown ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <>
                <Plus className="size-3" />
                <span>{t('milestoneAdd')}</span>
              </>
            )}
          </button>
        )}
      >
        <div className="max-h-56 overflow-y-auto">
          {milestones.map((option) => (
            <DropdownItem
              key={option.id}
              icon={<Flag className="size-3.5" />}
              {...(option.id === shownId ? { trailing: <Check className="size-3.5" /> } : {})}
              onSelect={() => assign(option.id)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{option.name}</span>
                {option.targetDate && (
                  <span className="shrink-0 font-mono text-[11px] text-faint">
                    {option.targetDate}
                  </span>
                )}
              </span>
            </DropdownItem>
          ))}
          {milestones.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-faint">{t('milestoneNone')}</p>
          )}
        </div>
        {shown && (
          <>
            <DropdownSeparator />
            <DropdownItem icon={<X className="size-3.5" />} onSelect={() => assign(null)}>
              {t('milestoneClear')}
            </DropdownItem>
          </>
        )}
      </DropdownMenu>
    </div>
  )
}
