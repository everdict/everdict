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
  // 목표일이 있으면 함께 보여 준다 — 체크포인트를 고르는 판단은 "언제까지"가 절반이다.
  targetDate?: string
}

// 이슈가 걸린 프로젝트 체크포인트 — 프로젝트 바로 아래 줄에서 붙이고 뗀다. 마일스톤은 프로젝트 안에서만
// 의미가 있어(제어 평면이 "이 이슈 프로젝트의 것인가"를 판정한다) 프로젝트가 없는 이슈에는 이 줄이 아예
// 나오지 않는다. 이름은 링크가 아니다 — 체크포인트는 자기 주소가 없고 프로젝트 상세 안에서만 산다.
export function IssueMilestoneControl({
  id,
  milestone,
  milestones,
  canWrite,
}: {
  id: string
  milestone: IssueMilestoneOption | undefined
  // 이 이슈가 들어가 있는 프로젝트의 체크포인트들 — 다른 프로젝트 것은 제어 평면이 거절하므로 여기 오지 않는다.
  milestones: IssueMilestoneOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [saving, setSaving] = useState(false)

  // 서버가 받아들인 값이 곧 이 줄의 새 진실이다 — 프로젝트 컨트롤과 같은 규칙(`use-refresh` 주석 참고).
  const serverId = milestone?.id ?? null
  const [chosenId, setChosenId] = useState<string | null | undefined>(undefined)
  if (chosenId !== undefined && chosenId === serverId) setChosenId(undefined)
  const shownId = chosenId === undefined ? serverId : chosenId
  const shown =
    shownId === null ? undefined : (milestones.find((m) => m.id === shownId) ?? milestone)

  // `null` 은 비운다 — 체크포인트에서 뗀다는 뜻이고, `undefined`(손대지 않음)와 절대 섞이면 안 된다.
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
                : // 아직 아무 체크포인트에도 없는 이슈에서는 이 버튼이 유일한 안내다 — 그때만 글자를 단다.
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
