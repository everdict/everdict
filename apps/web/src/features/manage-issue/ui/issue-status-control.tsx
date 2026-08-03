'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { issueStatusIcon, IssueStatusIcon, type IssueStatus } from '@/entities/issue'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { setIssueStatusAction } from '../api/issues'
import { ResolveIssueDialog, type ResolvableScorecard } from './resolve-issue-dialog'

// Which moves the domain will accept from here. An open issue moves between open states, cancels, or resolves;
// a terminal one can only be reopened — and `regressed` exists solely as the fall from a resolution, so it is
// offered only when the issue is currently done.
function reachableFrom(status: IssueStatus): IssueStatus[] {
  if (status === 'done') return ['regressed', 'todo', 'in_progress', 'in_review', 'backlog']
  if (status === 'cancelled') return ['backlog', 'todo', 'in_progress', 'in_review']
  return (['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const).filter(
    (s) => s !== status
  )
}

// The house state control: a status icon that opens a dropdown (never a row of text links).
export function IssueStatusControl({
  id,
  status,
  canWrite,
  scorecards,
  states = [],
}: {
  id: string
  status: IssueStatus
  canWrite: boolean
  scorecards: ResolvableScorecard[]
  // 이 이슈가 속한 팀의 보드 컬럼들. 있으면 팀이 붙인 이름으로 고르고(리니어와 같은 동선), 없으면 정규
  // 어휘로 떨어진다 — 어느 쪽이든 서버가 받는 것은 같은 전이다.
  states?: { id: string; name: string; status: IssueStatus }[]
}) {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')
  const router = useRouter()
  const [resolving, setResolving] = useState(false)
  const [pending, startTransition] = useTransition()

  function move(to: IssueStatus, resolution?: { scorecardId?: string; note?: string }, stateId?: string) {
    startTransition(async () => {
      const r = await setIssueStatusAction(id, to, resolution, stateId)
      if (!r.ok) {
        // An illegal move is the domain's own refusal — surface it verbatim rather than guessing a next step.
        toast.error(r.error ?? t('statusError'))
        return
      }
      setResolving(false)
      router.refresh()
    })
  }

  if (!canWrite) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-[12px] font-[510] text-secondary-foreground">
        <IssueStatusIcon status={status} className="[&_svg]:size-3.5" />
        {tracker(`issueStatus.${status}`)}
      </span>
    )
  }

  return (
    <>
      <DropdownMenu
        align="end"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('statusControlLabel')}
            disabled={pending}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-[12px] font-[510] text-secondary-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground disabled:opacity-50'
            )}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <IssueStatusIcon status={status} className="[&_svg]:size-3.5" />
            )}
            {tracker(`issueStatus.${status}`)}
            <ChevronDown className="size-3 text-faint" />
          </button>
        )}
      >
        <DropdownLabel>{t('statusMoveTo')}</DropdownLabel>
        {/* 팀 보드가 있으면 그 이름들로 — 닿을 수 있는 정규 상태에 매핑된 컬럼만 낸다. */}
        {(states.length > 0
          ? states
              .filter((state) => reachableFrom(status).includes(state.status))
              .map((state) => ({ key: state.id, label: state.name, to: state.status, stateId: state.id }))
          : reachableFrom(status).map((next) => ({
              key: next,
              label: tracker(`issueStatus.${next}`),
              to: next,
              stateId: undefined,
            }))
        ).map((option) => {
          const Icon = issueStatusIcon(option.to)
          return (
            <DropdownItem
              key={option.key}
              icon={<Icon className="size-3.5" />}
              onSelect={() =>
                option.to === 'done' ? setResolving(true) : move(option.to, undefined, option.stateId)
              }
            >
              {option.label}
            </DropdownItem>
          )
        })}
      </DropdownMenu>
      <ResolveIssueDialog
        open={resolving}
        onClose={() => setResolving(false)}
        onResolve={(resolution) => move('done', resolution)}
        pending={pending}
        scorecards={scorecards}
      />
    </>
  )
}
