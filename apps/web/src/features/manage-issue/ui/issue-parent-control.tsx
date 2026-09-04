'use client'

import { useState } from 'react'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Check, ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { issueHref, IssueStatusIcon, type IssueStatus } from '@/entities/issue'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'

import { updateIssueAction } from '../api/issues'

export interface IssueParentOption {
  id: string
  identifier: string
  title: string
  // The status comes along too — putting work under an issue that is already FINISHED and under one in progress are different decisions.
  status: IssueStatus
}

// Past this many choices a search line appears — the same threshold as the project picker.
const SEARCH_FROM = 7

// The parent issue this one was split out of — read and changed right where status, project and cycle are (the attribute column).
//
// The parent used to exist only as a fragment of an identifier in the breadcrumb. So opening a sub-issue left "what is this a sub-issue OF"
// to be guessed from that short `ENG-11`, and there was nowhere on screen to attach or detach one (only an agent could). The attribute column
// is where what this issue BELONGS TO is collected, and the parent issue is the belonging that has to be read first of all.
export function IssueParentControl({
  workspace,
  id,
  parent,
  options,
  canWrite,
}: {
  workspace: string
  id: string
  parent: IssueParentOption | undefined
  // The issues that could be set as parent — the screen filters to the same team's. Itself and its own sub-issues are excluded
  // (setting your own descendant as parent closes a cycle). Deeper descendants are judged by the control plane, and its refusal is shown verbatim.
  options: IssueParentOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)

  // `null` CLEARS it — it means detach from the parent, and it must never be conflated with `undefined` (untouched).
  function assign(parentId: string | null): void {
    if (parentId === (parent?.id ?? null)) return
    void (async () => {
      setPending(true)
      try {
        const r = await updateIssueAction(id, { parentId })
        if (!r.ok) {
          toast.error(r.error ?? t('parentError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const chip = parent ? (
    <Link
      href={issueHref(workspace, parent.identifier, parent.title)}
      title={`${parent.identifier} · ${parent.title}`}
      className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
    >
      <IssueStatusIcon status={parent.status} className="shrink-0" />
      <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
        {parent.identifier}
      </span>
      <span className="truncate">{parent.title}</span>
    </Link>
  ) : null

  if (!canWrite) return chip

  const needle = query.trim().toLocaleLowerCase()
  const choices = options.filter(
    (option) =>
      option.id !== id &&
      (needle === '' ||
        option.title.toLocaleLowerCase().includes(needle) ||
        option.identifier.toLocaleLowerCase().includes(needle))
  )
  const searchable = options.length > SEARCH_FROM

  return (
    <div className="flex min-w-0 items-center gap-1">
      {chip}
      <DropdownMenu
        align="end"
        contentClassName={cn('p-1', searchable && 'w-72')}
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('parentControlLabel')}
            disabled={pending}
            className={cn(
              'shrink-0 transition-colors disabled:opacity-50',
              parent
                ? 'inline-flex size-5 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground'
                : // On an issue that belongs nowhere yet, this button is the only affordance — that is the only time it wears a label.
                  'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:border-border-strong hover:bg-accent hover:text-foreground'
            )}
          >
            {pending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : parent ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <>
                <Plus className="size-3" />
                <span>{t('parentAdd')}</span>
              </>
            )}
          </button>
        )}
      >
        {searchable && (
          <div className="p-1">
            <Input
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('parentSearchPlaceholder')}
              // Guarding against the day this control sits inside a form — an Enter that submits the form would save mid-selection.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
            />
          </div>
        )}
        <div className="max-h-56 overflow-y-auto">
          {choices.map((option) => (
            <DropdownItem
              key={option.id}
              icon={<IssueStatusIcon status={option.status} />}
              {...(option.id === parent?.id ? { trailing: <Check className="size-3.5" /> } : {})}
              onSelect={() => assign(option.id)}
            >
              <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">
                {option.identifier}
              </span>
              {option.title}
            </DropdownItem>
          ))}
          {choices.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-faint">{t('parentNoMatch')}</p>
          )}
        </div>
        {parent && (
          <>
            <DropdownSeparator />
            <DropdownItem icon={<X className="size-3.5" />} onSelect={() => assign(null)}>
              {t('parentClear')}
            </DropdownItem>
          </>
        )}
      </DropdownMenu>
    </div>
  )
}
