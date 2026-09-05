'use client'

import { useState } from 'react'
import { Check, ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  ISSUE_LINK_REF_KIND,
  issueLinkHref,
  type IssueCapabilityLinkType,
  type IssueLink,
} from '@/entities/issue'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { EntityRef } from '@/shared/ui/chip'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'

import { addIssueLinkAction, removeIssueLinkAction } from '../api/links'

// Past this many choices a search line appears — the same threshold as the project picker (people are not left to find things by scrolling alone).
const SEARCH_FROM = 7

// One selectable capability — the things the workspace registry actually holds.
export interface CapabilityOption {
  id: string
  // The line beside it when a name alone does not distinguish (a model/command summary for a harness, the description for a dataset).
  hint?: string
}

interface CapabilityRef {
  id: string
  // A link that pinned a version too (historically, or by an agent over MCP) is shown as it is. A NEW link carries no version —
  // what an issue means is "this judge", not "the judge at 1.2.0", and regression watching matches by id as well
  // (docs/tracker.md). A screen that asks for a version makes the link read as though it were bound to one.
  version?: string
}

const refsOf = (links: IssueLink[]): CapabilityRef[] =>
  links.map((link) => ({
    id: link.id,
    ...(link.version !== undefined ? { version: link.version } : {}),
  }))

const keyOf = (links: IssueLink[]): string =>
  links.map((link) => `${link.id}@${link.version ?? ''}`).join(' ')

// One kind of capability that verifies this issue (harness, dataset, judge) — attached and detached right where status, project and labels
// are (the attribute column). This used to be a small form of a kind combo plus a free-text id plus a free-text version, which only
// somebody who had memorised what the registry held could use — one typo produced a link pointing nowhere (a link is a POINTER and the
// control plane does not validate it). So the only things selectable are what is registered in the workspace.
//
// Attaching and detaching save immediately (this is a control, not a form). The chip shows as changed while the save is in flight, and on a
// refusal it rolls back and shows the control plane's reason verbatim.
export function IssueCapabilityControl({
  workspace,
  issueId,
  type,
  links,
  options,
  canWrite,
}: {
  workspace: string
  issueId: string
  type: IssueCapabilityLinkType
  // The links already attached for this kind.
  links: IssueLink[]
  // The capabilities of the same kind registered in this workspace — everything that can be picked and attached.
  options: CapabilityOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issueLinks')
  const tracker = useTranslations('tracker')
  const refresh = useRefresh()
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState<CapabilityRef[]>(() => refsOf(links))
  const [seen, setSeen] = useState(() => keyOf(links))

  // What the SERVER carried is the truth — once a save finishes and the page re-renders, or another screen edits it, this follows.
  // It does not follow while a save is in flight: toggling twice in a row would make the first response undo the second choice and flicker.
  const fromServer = keyOf(links)
  if (!pending && fromServer !== seen) {
    setSeen(fromServer)
    setSelected(refsOf(links))
  }

  const kind = tracker(`linkType.${type}`)

  function toggle(id: string): void {
    const linked = selected.some((ref) => ref.id === id)
    const previous = selected
    setSelected(linked ? selected.filter((ref) => ref.id !== id) : [...selected, { id }])
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
        // The rest of the screen (history, evaluation history) follows behind. This row does not wait for it.
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const chips = selected.map((ref) => (
    <span
      key={ref.id}
      className="inline-flex max-w-full items-center gap-1 rounded bg-secondary py-0.5 pl-1.5 pr-1 text-[11px] text-secondary-foreground ring-1 ring-inset ring-border"
    >
      <Link
        href={issueLinkHref(workspace, type, ref.id)}
        title={ref.id}
        className="min-w-0 transition-colors hover:text-foreground"
      >
        <EntityRef
          id={ref.id}
          {...(ref.version !== undefined ? { version: ref.version } : {})}
          kind={ISSUE_LINK_REF_KIND[type]}
        />
      </Link>
      {canWrite && (
        <button
          type="button"
          onClick={() => toggle(ref.id)}
          disabled={pending}
          aria-label={t('remove', { id: ref.id })}
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
    (option) => needle === '' || option.id.toLocaleLowerCase().includes(needle)
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
            {/* On a row with nothing attached yet, this button is the only affordance — that is the only time it wears a label. */}
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
              // Guarding against the day this control sits inside a form — an Enter that submits the form would save mid-selection.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
            />
          </div>
        )}
        <div className="max-h-56 overflow-y-auto">
          {choices.map((option) => {
            const linked = selected.some((ref) => ref.id === option.id)
            return (
              <DropdownItem
                key={option.id}
                {...(linked ? { trailing: <Check className="size-3.5" /> } : {})}
                onSelect={() => toggle(option.id)}
              >
                <span className="font-mono text-[12px]">{option.id}</span>
                {option.hint !== undefined && (
                  <span className="text-[11px] text-faint"> · {option.hint}</span>
                )}
              </DropdownItem>
            )
          })}
          {choices.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-faint">
              {options.length === 0 ? t('none') : t('noMatch')}
            </p>
          )}
        </div>
      </DropdownMenu>
    </div>
  )
}
