'use client'

import { useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { issueStatusIcon, IssueStatusIcon, type IssueStatus } from '@/entities/issue'
import { orderWorkflowStates } from '@/entities/workflow-state'
import { useRefresh } from '@/shared/lib/use-refresh'
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
  variant = 'default',
}: {
  id: string
  status: IssueStatus
  canWrite: boolean
  scorecards: ResolvableScorecard[]
  // `icon` is the list row's density — the icon alone, with the name in a tooltip. The SAME control used at two densities rather than a
  // row-specific copy: the status vocabulary, the reachable transitions and the resolution dialog on done must live in one place.
  variant?: 'default' | 'icon'
  // The board columns of this issue's team. Present, the choice is by the names the TEAM attached (the same path as Linear); absent, it falls
  // back to the canonical vocabulary — either way what the server receives is the same transition. `position` is used to re-establish the
  // board's order (orderWorkflowStates) — the order within a slot is the team's decision and must not be invented by the screen.
  states?: { id: string; name: string; status: IssueStatus; position: number }[]
}) {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')
  const refresh = useRefresh()
  const [resolving, setResolving] = useState(false)
  const [pending, setPending] = useState(false)

  function move(
    to: IssueStatus,
    resolution?: { scorecardId?: string; note?: string },
    stateId?: string
  ) {
    void (async () => {
      setPending(true)
      try {
        const r = await setIssueStatusAction(id, to, resolution, stateId)
        if (!r.ok) {
          // An illegal move is the domain's own refusal — surface it verbatim rather than guessing a next step.
          toast.error(r.error ?? t('statusError'))
          return
        }
        setResolving(false)
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  if (!canWrite) {
    if (variant === 'icon')
      return (
        <span
          className="inline-flex shrink-0 items-center"
          title={tracker(`issueStatus.${status}`)}
        >
          <IssueStatusIcon status={status} className="[&_svg]:size-3.5" />
        </span>
      )
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
            title={variant === 'icon' ? tracker(`issueStatus.${status}`) : undefined}
            disabled={pending}
            className={cn(
              variant === 'icon'
                ? 'inline-flex shrink-0 items-center rounded-md p-1 transition-colors hover:bg-accent disabled:opacity-50'
                : 'inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-[12px] font-[510] text-secondary-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground disabled:opacity-50'
            )}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <IssueStatusIcon status={status} className="[&_svg]:size-3.5" />
            )}
            {variant === 'default' && tracker(`issueStatus.${status}`)}
            {variant === 'default' && <ChevronDown className="size-3 text-faint" />}
          </button>
        )}
      >
        <DropdownLabel>{t('statusMoveTo')}</DropdownLabel>
        {/* With a team board, by ITS names — only columns mapped to a reachable canonical status are offered.
            The order is re-established as the BOARD's (canonical status → the position within it): the server sorts by `position` alone and a new
            column is appended at the board's end, so a team adding another column to "in review" would otherwise see it appear below "cancelled". */}
        {(states.length > 0
          ? orderWorkflowStates(states)
              .filter((state) => reachableFrom(status).includes(state.status))
              .map((state) => ({
                key: state.id,
                label: state.name,
                to: state.status,
                stateId: state.id,
              }))
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
                option.to === 'done'
                  ? setResolving(true)
                  : move(option.to, undefined, option.stateId)
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
