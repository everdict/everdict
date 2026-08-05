'use client'

import { useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  ISSUE_PRIORITIES,
  issuePriorityIcon,
  IssuePriorityIcon,
  type IssuePriority,
} from '@/entities/issue'
import { useRefresh } from '@/shared/lib/use-refresh'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { updateIssueAction } from '../api/issues'

// 상태·팀과 같은 하우스 문법(아이콘 + 드롭다운). 우선순위는 워크플로 전이가 아니라 내용 편집이라
// `updateIssueAction` 으로 간다 — 이력에는 `updated{changed:[priority]}` 한 줄로 남는다.
export function IssuePriorityControl({
  id,
  priority,
  canWrite,
  variant = 'default',
}: {
  id: string
  priority: IssuePriority
  canWrite: boolean
  // 상태 컨트롤과 같은 두 밀도 — 목록 행에서는 아이콘만 선다.
  variant?: 'default' | 'icon'
}) {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)

  function set(next: IssuePriority) {
    void (async () => {
      setPending(true)
      try {
        const r = await updateIssueAction(id, { priority: next })
        if (!r.ok) {
          toast.error(r.error ?? t('priorityError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const label = (
    <>
      <IssuePriorityIcon priority={priority} className="[&_svg]:size-3.5" />
      {tracker(`issuePriority.${priority}`)}
    </>
  )

  if (!canWrite)
    return variant === 'icon' ? (
      <span
        className="inline-flex shrink-0 items-center"
        title={tracker(`issuePriority.${priority}`)}
      >
        <IssuePriorityIcon priority={priority} className="[&_svg]:size-3.5" />
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5">{label}</span>
    )

  return (
    <DropdownMenu
      align="end"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={t('priorityControlLabel')}
          title={variant === 'icon' ? tracker(`issuePriority.${priority}`) : undefined}
          disabled={pending}
          className={
            variant === 'icon'
              ? 'inline-flex shrink-0 items-center rounded-md p-1 transition-colors hover:bg-accent disabled:opacity-50'
              : 'inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50'
          }
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : variant === 'icon' ? (
            <IssuePriorityIcon priority={priority} className="[&_svg]:size-3.5" />
          ) : (
            label
          )}
          {variant === 'default' && <ChevronDown className="size-3 shrink-0 text-faint" />}
        </button>
      )}
    >
      <DropdownLabel>{t('prioritySetTo')}</DropdownLabel>
      {ISSUE_PRIORITIES.filter((option) => option !== priority).map((option) => {
        const Icon = issuePriorityIcon(option)
        return (
          <DropdownItem
            key={option}
            icon={<Icon className="size-3.5" />}
            onSelect={() => set(option)}
          >
            {tracker(`issuePriority.${option}`)}
          </DropdownItem>
        )
      })}
    </DropdownMenu>
  )
}
