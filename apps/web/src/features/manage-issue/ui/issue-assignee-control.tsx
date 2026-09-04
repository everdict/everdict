'use client'

import { useState } from 'react'
import { Check, ChevronDown, Loader2, UserRound } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { memberNameOf, type MemberDirectory } from '@/entities/member'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import {
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
} from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'

import { updateIssueAction } from '../api/issues'

// Past this many choices a search line appears — the same threshold as the project and parent-issue pickers. People are the axis that grows
// fastest of any list (it keeps growing as members join), so nobody is left to find one by scrolling.
const SEARCH_FROM = 7

// The assignee — the same house grammar as status and priority (an icon plus a dropdown), and for the same reason it lives BOTH on the list row
// and in the detail's attribute column: Linear has neither the round trip of opening and closing an issue just to change its assignee, nor the
// round trip of going back to the list to change the assignee of an issue you already have open. It is a content edit rather than a workflow
// transition, so it goes through `updateIssue` and leaves one `updated{changed:[assignee]}` line in the history.
export function IssueAssigneeControl({
  id,
  assignee,
  actors,
  // Who can be picked — the workspace member list. The directory knows the names of people who have left too, but only current members can be
  // assigned.
  members,
  canWrite,
  variant = 'default',
  className,
}: {
  id: string
  assignee?: string
  actors: MemberDirectory
  members: { subject: string; name: string; avatarUrl?: string }[]
  canWrite: boolean
  // The same two densities as the status and priority controls — a face alone on a list row, the name too in the attribute column (the
  // attribute column is a place you READ rather than sweep, so nobody is made to guess who it is from a face).
  variant?: 'default' | 'icon'
  className?: string
}) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)

  // `null` CLEARS it — it means unassign, and it must never be conflated with `undefined` (untouched).
  function set(next: string | null): void {
    if (next === (assignee ?? null)) return
    void (async () => {
      setPending(true)
      try {
        const r = await updateIssueAction(id, { assignee: next })
        if (!r.ok) {
          toast.error(r.error ?? t('assigneeError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const name = assignee === undefined ? t('fieldAssigneeNone') : memberNameOf(actors, assignee)
  const face =
    assignee === undefined ? (
      // Unassigned is an answer that has to be drawn too — an empty slot cannot say "nobody yet".
      <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-faint">
        <UserRound className="size-3" strokeWidth={1.75} aria-hidden />
      </span>
    ) : (
      <Avatar
        name={name}
        size="sm"
        {...(actors[assignee]?.avatarUrl !== undefined ? { url: actors[assignee].avatarUrl } : {})}
      />
    )

  if (!canWrite)
    return variant === 'icon' ? (
      <span className={cn('inline-flex items-center', className)} title={name}>
        {face}
      </span>
    ) : (
      <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
        {face}
        <span className={cn('truncate', assignee === undefined && 'text-muted-foreground')}>
          {name}
        </span>
      </span>
    )

  const needle = query.trim().toLocaleLowerCase()
  const choices = members.filter(
    (member) => needle === '' || member.name.toLocaleLowerCase().includes(needle)
  )
  const searchable = members.length > SEARCH_FROM

  return (
    <DropdownMenu
      align="end"
      contentClassName={cn(searchable && 'w-64 p-1')}
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={t('assigneeControlLabel')}
          title={variant === 'icon' ? name : undefined}
          disabled={pending}
          className={cn(
            'transition-colors disabled:opacity-50',
            variant === 'icon'
              ? 'inline-flex items-center rounded-full p-0.5 hover:bg-accent'
              : 'inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-accent hover:text-foreground',
            className
          )}
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : face}
          {variant === 'default' && (
            <>
              <span className={cn('truncate', assignee === undefined && 'text-muted-foreground')}>
                {name}
              </span>
              <ChevronDown className="size-3 shrink-0 text-faint" />
            </>
          )}
        </button>
      )}
    >
      {searchable ? (
        <div className="p-1">
          <Input
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('assigneeSearchPlaceholder')}
            // Guarding against the day this control sits inside a form — an Enter that submits the form would save mid-selection.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault()
            }}
          />
        </div>
      ) : (
        <DropdownLabel>{t('assigneeSetTo')}</DropdownLabel>
      )}
      <div className="max-h-56 overflow-y-auto">
        {choices.map((member) => (
          <DropdownItem
            key={member.subject}
            icon={
              <Avatar
                name={member.name}
                size="sm"
                {...(member.avatarUrl !== undefined ? { url: member.avatarUrl } : {})}
              />
            }
            {...(member.subject === assignee ? { trailing: <Check className="size-3.5" /> } : {})}
            onSelect={() => set(member.subject)}
          >
            {member.name}
          </DropdownItem>
        ))}
        {choices.length === 0 && (
          <p className="px-2 py-1.5 text-[12px] text-faint">{t('assigneeNoMatch')}</p>
        )}
      </div>
      {assignee !== undefined && (
        <>
          <DropdownSeparator />
          <DropdownItem icon={<UserRound className="size-3.5" />} onSelect={() => set(null)}>
            {t('assigneeClear')}
          </DropdownItem>
        </>
      )}
    </DropdownMenu>
  )
}
