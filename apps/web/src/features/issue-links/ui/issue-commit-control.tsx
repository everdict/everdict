'use client'

import { useState } from 'react'
import { ChevronDown, GitCommitHorizontal, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { issueCommitUrl, parseIssueCommitRef, type IssueLink } from '@/entities/issue'
import { useRefresh } from '@/shared/lib/use-refresh'
import { LinkChip, LinkChipRow } from '@/shared/ui/chip'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'

import { addIssueLinkAction, removeIssueLinkAction } from '../api/links'

// The commits that did the work — the answer to "what closed this?", which before this row existed was
// recorded only inside a change campaign's round and was therefore unreachable to anyone reading the issue.
//
// Why this is NOT the mention control with another kind passed in: that control PICKS from a candidate list,
// and a commit has no candidate list here. The change exists in somebody's repository whether or not this
// workspace has ever heard of it, so the input is an address the member pastes — the same thing they copied
// out of the browser — and the parsing of it is this screen's job (`parseIssueCommitRef`, one owner, shared
// with the counterexample that pins the accepted forms).
export function IssueCommitControl({
  issueId,
  links,
  canWrite,
}: {
  issueId: string
  // The commit links already on the record, in the order they were added.
  links: IssueLink[]
  canWrite: boolean
}) {
  const t = useTranslations('issueLinks')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)

  function add(): void {
    const ref = parseIssueCommitRef(draft)
    // Refused HERE rather than at the server, because the member is looking at the field they just pasted into
    // and can fix it. A round trip would answer the same thing one second later, somewhere they are not looking.
    if (ref === undefined) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setDraft('')
    void (async () => {
      setPending(true)
      try {
        const r = await addIssueLinkAction(issueId, {
          type: 'commit',
          id: ref.sha,
          repository: ref.repository,
          ...(ref.host !== undefined ? { host: ref.host } : {}),
        })
        if (!r.ok) {
          toast.error(r.error ?? t('addError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  function remove(link: IssueLink): void {
    void (async () => {
      setPending(true)
      try {
        // The repository travels with the removal: two repositories can each hold a sha with the same
        // abbreviation, and a removal by sha alone would take both of them.
        const r = await removeIssueLinkAction(issueId, 'commit', link.id, {
          ...(link.repository !== undefined ? { repository: link.repository } : {}),
        })
        if (!r.ok) {
          toast.error(r.error ?? t('addError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  // `owner/name@abc1234` — the repository is what tells two commits apart at a glance, and the abbreviation is
  // what a person actually reads. The full sha and the note are in the tooltip, where the whole of it fits.
  const chips = links.map((link) => {
    const short = link.id.slice(0, 7)
    const label = link.repository === undefined ? short : `${link.repository}@${short}`
    return (
      <LinkChip
        key={`${link.repository ?? ''}@${link.id}`}
        external
        href={issueCommitUrl(link) ?? '#'}
        title={link.note === undefined ? `${label} · ${link.id}` : `${label} · ${link.note}`}
        {...(canWrite
          ? {
              trailing: (
                <button
                  type="button"
                  onClick={() => remove(link)}
                  disabled={pending}
                  aria-label={t('remove', { id: short })}
                  className="rounded p-0.5 text-faint transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                >
                  <X className="size-3" />
                </button>
              ),
            }
          : {})}
      >
        <GitCommitHorizontal className="size-3 shrink-0 text-faint" />
        <span className="min-w-0 truncate font-mono">{label}</span>
      </LinkChip>
    )
  })

  if (!canWrite) {
    if (chips.length === 0) return null
    return <LinkChipRow>{chips}</LinkChipRow>
  }

  return (
    <LinkChipRow>
      {chips}
      <DropdownMenu
        align="end"
        contentClassName="w-80 p-2"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('commitControlLabel')}
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
        <div className="space-y-1.5">
          <Input
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setInvalid(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder={t('commitPlaceholder')}
            aria-label={t('commitControlLabel')}
            aria-invalid={invalid}
            className="text-xs"
          />
          {/* The hint says what IS accepted rather than what went wrong — a member who pasted the wrong thing
              needs the right shape, not a verdict on the one they tried. */}
          <p className={invalid ? 'text-[11px] text-destructive' : 'text-[11px] text-faint'}>
            {t('commitHint')}
          </p>
        </div>
      </DropdownMenu>
    </LinkChipRow>
  )
}
