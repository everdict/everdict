'use client'

import { useState } from 'react'
import { ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  issueHref,
  IssueSearchOptions,
  IssueStatusIcon,
  type IssueMentionLinkType,
  type IssueOption,
} from '@/entities/issue'
import { useRefresh } from '@/shared/lib/use-refresh'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Link } from '@/shared/ui/link'

import { addIssueLinkAction, removeIssueLinkAction } from '../api/links'

// The other issues this one **mentions** — the cross-reference GitHub writes as `#123`, made here by PICKING
// (a user decision: a picker rather than auto-parsing the body text). It is stored one-directionally on the mentioning record, and the
// mentioned issue draws its own "mentioned by" row from a reverse query — so it is visible from both sides.
//
// The link holds a UUID, which says nothing to a person by itself. The identifier, title and status needed to draw it are already resolved and
// passed down by the server component (`mentions`), and something just picked here uses the row the picker gave verbatim.
export function IssueMentionControl({
  workspace,
  issueId,
  type,
  mentions,
  canWrite,
}: {
  workspace: string
  issueId: string
  // Today that is `issue` alone — as the vocabulary grows, the same control takes the kind (`ISSUE_MENTION_LINK_TYPES`).
  type: IssueMentionLinkType
  // What this issue mentions, already resolved.
  mentions: IssueOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issueLinks')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState<IssueOption[]>(mentions)
  const [seen, setSeen] = useState(() => mentions.map((m) => m.id).join(' '))

  // What the SERVER carried is the truth — once a save finishes and the page re-renders, or another screen edits it, this follows.
  // It does not follow while a save is in flight: picking twice in a row would make the first response undo the second choice and flicker.
  const fromServer = mentions.map((m) => m.id).join(' ')
  if (!pending && fromServer !== seen) {
    setSeen(fromServer)
    setSelected(mentions)
  }

  function mutate(next: IssueOption[], run: () => Promise<{ ok: boolean; error?: string }>): void {
    const previous = selected
    setSelected(next)
    void (async () => {
      setPending(true)
      try {
        const r = await run()
        if (!r.ok) {
          setSelected(previous)
          toast.error(r.error ?? t('addError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const add = (issue: IssueOption): void =>
    mutate([...selected, issue], () => addIssueLinkAction(issueId, { type, id: issue.id }))

  const remove = (issue: IssueOption): void =>
    mutate(
      selected.filter((x) => x.id !== issue.id),
      () => removeIssueLinkAction(issueId, type, issue.id)
    )

  const chips = selected.map((issue) => (
    <span
      key={issue.id}
      className="inline-flex max-w-full items-center gap-1 rounded bg-secondary py-0.5 pl-1.5 pr-1 text-[11px] text-secondary-foreground ring-1 ring-inset ring-border"
    >
      <Link
        href={issueHref(workspace, issue.identifier, issue.title)}
        title={`${issue.identifier} · ${issue.title}`}
        className="inline-flex min-w-0 items-center gap-1 transition-colors hover:text-foreground"
      >
        <IssueStatusIcon status={issue.status} />
        <span className="shrink-0 font-mono">{issue.identifier}</span>
        <span className="min-w-0 truncate">{issue.title}</span>
      </Link>
      {canWrite && (
        <button
          type="button"
          onClick={() => remove(issue)}
          disabled={pending}
          aria-label={t('remove', { id: issue.identifier })}
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

  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips}
      <DropdownMenu
        align="end"
        contentClassName="w-72 p-2"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('mentionControlLabel')}
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
        {/* Itself and what it already mentions are not candidates — the only selectable things are those that would genuinely be new links. */}
        <IssueSearchOptions
          autoFocus
          exclude={[issueId, ...selected.map((issue) => issue.id)]}
          onSelect={add}
        />
      </DropdownMenu>
    </div>
  )
}
