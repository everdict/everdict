'use client'

import { useState } from 'react'
import { Check, ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { issueLinkHref, type IssueLink } from '@/entities/issue'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'

import { addIssueLinkAction, removeIssueLinkAction } from '../api/links'

// The same threshold as the capability control — people are not left to find things by scrolling.
const SEARCH_FROM = 7

// One product or release entry — the link holds a UUID, so this control always draws it **by name**.
export interface TimelineLinkOption {
  id: string
  label: string
  hint?: string
}

// The products and releases this issue blocks or belongs to — a row in the same attribute column as status and project. It shares the capability
// control's grammar (save immediately, roll back on failure) but is a separate component because a capability chip's id IS the name a person
// reads, while a product's or release's id is a UUID that always has to be resolved into a name — and a deleted target has to SAY so.
// The release gate counts these links with a reverse query, so attaching one here becomes the gate's own grounds.
export function IssueTimelineLinkControl({
  workspace,
  issueId,
  type,
  links,
  options,
  canWrite,
}: {
  workspace: string
  issueId: string
  type: 'product' | 'release'
  links: IssueLink[]
  options: TimelineLinkOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issueLinks')
  const tracker = useTranslations('tracker')
  const refresh = useRefresh()
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState<string[]>(() => links.map((link) => link.id))
  const [seen, setSeen] = useState(() => links.map((link) => link.id).join(' '))

  // What the SERVER carried is the truth — the same resynchronization rule as the capability control (it does not follow while a save is in flight).
  const fromServer = links.map((link) => link.id).join(' ')
  if (!pending && fromServer !== seen) {
    setSeen(fromServer)
    setSelected(links.map((link) => link.id))
  }

  const kind = tracker(`linkType.${type}`)
  const labelOf = (id: string): string => options.find((option) => option.id === id)?.label ?? t('missingTarget')

  function toggle(id: string): void {
    const linked = selected.includes(id)
    const previous = selected
    setSelected(linked ? selected.filter((entry) => entry !== id) : [...selected, id])
    void (async () => {
      setPending(true)
      try {
        const r = linked
          ? await removeIssueLinkAction(issueId, type, id)
          : await addIssueLinkAction(issueId, { type, id })
        if (!r.ok) {
          setSelected(previous)
          toast.error(r.error ?? t(linked ? 'removeError' : 'addError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const chips = selected.map((id) => (
    <span
      key={id}
      className="inline-flex max-w-full items-center gap-1 rounded bg-secondary py-0.5 pl-1.5 pr-1 text-[11px] text-secondary-foreground ring-1 ring-inset ring-border"
    >
      <Link
        href={issueLinkHref(workspace, type, id)}
        title={id}
        className="min-w-0 truncate transition-colors hover:text-foreground"
      >
        {labelOf(id)}
      </Link>
      {canWrite && (
        <button
          type="button"
          onClick={() => toggle(id)}
          disabled={pending}
          aria-label={t('remove', { id: labelOf(id) })}
          className="rounded p-0.5 text-faint transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  ))

  if (!canWrite) {
    if (chips.length === 0) return null
    return <span className="inline-flex flex-wrap items-center gap-1">{chips}</span>
  }

  const needle = query.trim().toLocaleLowerCase()
  const choices = options.filter(
    (option) => needle === '' || option.label.toLocaleLowerCase().includes(needle)
  )
  const searchable = options.length > SEARCH_FROM

  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips}
      <DropdownMenu
        align="end"
        contentClassName={cn('p-1', searchable && 'w-64')}
        trigger={({ toggle: openMenu, open: menuOpen }) => (
          <button
            type="button"
            onClick={openMenu}
            aria-expanded={menuOpen}
            aria-label={t('controlLabel', { kind })}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {pending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : chips.length === 0 ? (
              <Plus className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
            {chips.length === 0 && <span>{t('add')}</span>}
          </button>
        )}
      >
        {searchable && (
          <div className="p-1">
            <Input
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
            />
          </div>
        )}
        <div className="max-h-56 overflow-y-auto">
          {choices.map((option) => {
            const linked = selected.includes(option.id)
            return (
              <DropdownItem
                key={option.id}
                {...(linked ? { trailing: <Check className="size-3.5" /> } : {})}
                onSelect={() => toggle(option.id)}
              >
                <span className="text-[12px]">{option.label}</span>
                {option.hint !== undefined && (
                  <span className="text-[11px] text-faint"> · {option.hint}</span>
                )}
              </DropdownItem>
            )
          })}
          {choices.length === 0 && (
            <p className="px-2 py-1.5 text-[11.5px] text-muted-foreground">{t('noMatch')}</p>
          )}
        </div>
      </DropdownMenu>
    </div>
  )
}
