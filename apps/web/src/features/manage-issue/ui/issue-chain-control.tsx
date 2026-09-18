'use client'

import { useState } from 'react'
import { CheckCircle2, ChevronDown, CircleDashed, FileText, Loader2, Ship, XCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { IssueChain } from '@/entities/issue'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'

import { type IssueChainMove, setIssueChainAction } from '../api/issues'

// ── THE WORK CHAIN, ON THE SCREEN (DEFAUL-39 S3) ─────────────────────────────────────────────────────
//
// A SECOND AXIS beside the status control, and drawn as one: the board says where the work is, this says
// whether the request was DESIGNED, decided and shipped. They never move each other, so they are never one
// control — a single menu would make one click answer two questions.
//
// ⚠️ ABSENT IS NOT A DRAFT. An issue that predates the chain has none, and drawing it as "draft" would say
// nobody has designed a request that may already have shipped. It renders as its own thing, and the only move
// offered is the one that enters the chain.
//
// ⚠️ ACCEPTING ASKS FOR THE DESIGN AND WILL NOT PROCEED WITHOUT ONE. That is the whole invariant reaching a
// person: the control plane refuses an acceptance with neither a spec nor a declination, and a screen that
// offered a bare "Accept" button would send a request it knows will be refused — or worse, invite somebody to
// look for the field that does not exist.
export function IssueChainControl({
  id,
  chain,
  canWrite,
}: {
  id: string
  chain: IssueChain | undefined
  canWrite: boolean
}) {
  const t = useTranslations('issueChain')
  const refresh = useRefresh()
  const [saving, setSaving] = useState(false)
  // Which move is collecting its required value. `undefined` = the menu is just a menu.
  const [asking, setAsking] = useState<'spec' | 'declined' | 'reject' | undefined>()
  const [value, setValue] = useState('')

  const move = async (body: IssueChainMove) => {
    setSaving(true)
    const result = await setIssueChainAction(id, body)
    setSaving(false)
    if (!result.ok) {
      // The control plane's sentence is shown verbatim — it names WHICH rule refused (no design, the commit
      // predates the acceptance, this request already shipped), and a generic "could not save" would throw
      // away the only part a person can act on.
      toast.error(result.error ?? t('failed'))
      return
    }
    setAsking(undefined)
    setValue('')
    refresh()
  }

  const state = chain?.state
  const icon =
    state === 'accepted' ? (
      <CheckCircle2 className="size-3.5 text-success" />
    ) : state === 'rejected' ? (
      <XCircle className="size-3.5 text-muted-foreground" />
    ) : state === 'shipped' ? (
      <Ship className="size-3.5 text-success" />
    ) : (
      <CircleDashed className="size-3.5 text-faint" />
    )

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        {icon}
        <DropdownMenu
          trigger={({ toggle, open }) => (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              disabled={!canWrite || saving}
              className="inline-flex items-center gap-1 text-[13px] text-foreground transition-colors disabled:opacity-60"
            >
              {state === undefined ? t('state.none') : t(`state.${state}`)}
              {saving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : canWrite ? (
                <ChevronDown className="size-3" />
              ) : null}
            </button>
          )}
        >
          {state === undefined || state === 'draft' ? (
            <>
              <DropdownItem onSelect={() => setAsking('spec')}>{t('move.acceptWithSpec')}</DropdownItem>
              <DropdownItem onSelect={() => setAsking('declined')}>{t('move.acceptDeclining')}</DropdownItem>
              <DropdownSeparator />
              <DropdownItem onSelect={() => setAsking('reject')}>{t('move.reject')}</DropdownItem>
            </>
          ) : null}
          {state === 'accepted' ? (
            <>
              <DropdownItem onSelect={() => void move({ move: 'ship' })}>{t('move.ship')}</DropdownItem>
              <DropdownItem onSelect={() => setAsking('reject')}>{t('move.reject')}</DropdownItem>
            </>
          ) : null}
          {state === 'rejected' ? (
            <DropdownItem onSelect={() => void move({ move: 'redraft' })}>{t('move.redraft')}</DropdownItem>
          ) : null}
        </DropdownMenu>
      </div>

      {/* What the acceptance rests on, read back. A design nobody can see afterwards is the silence the
          declination exists to end, so it is shown rather than hidden behind a hover. */}
      {chain?.state === 'accepted' ? (
        <p className="flex items-start gap-1.5 pl-5.5 text-[11px] text-muted-foreground">
          <FileText className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">
            {chain.design.kind === 'spec' ? chain.design.path : t('declined', { why: chain.design.why })}
          </span>
        </p>
      ) : null}
      {chain?.state === 'rejected' ? (
        <p className="pl-5.5 text-[11px] text-muted-foreground">{t('rejectedFor', { reason: chain.reason })}</p>
      ) : null}
      {state === undefined ? (
        <p className="pl-5.5 text-[11px] text-faint">{t('predatesTheChain')}</p>
      ) : null}

      {asking !== undefined ? (
        <form
          className="space-y-1.5 pl-5.5"
          onSubmit={(e) => {
            e.preventDefault()
            const entered = value.trim()
            if (entered === '') return
            void move(
              asking === 'reject'
                ? { move: 'reject', reason: entered }
                : asking === 'spec'
                  ? { move: 'accept', design: { kind: 'spec', path: entered } }
                  : { move: 'accept', design: { kind: 'declined', why: entered } }
            )
          }}
        >
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t(`ask.${asking}`)}
            className={cn(
              'w-full rounded-md border bg-card px-2 py-1 text-[12px] text-foreground',
              'placeholder:text-faint focus:border-border-strong focus:outline-none'
            )}
          />
          <div className="flex gap-1.5">
            {/* Disabled on empty rather than sent-and-refused: the required value is the invariant, and a
                screen that lets it go empty is asking the control plane to say no on its behalf. */}
            <button
              type="submit"
              disabled={saving || value.trim() === ''}
              className="rounded border px-2 py-0.5 text-[11px] text-foreground disabled:opacity-50"
            >
              {t('confirm')}
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(undefined)
                setValue('')
              }}
              className="rounded px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {t('cancel')}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
