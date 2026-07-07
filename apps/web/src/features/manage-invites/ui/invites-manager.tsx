'use client'

import { useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import type { Invite } from '@/entities/member'
import { copyText } from '@/shared/lib/clipboard'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Label } from '@/shared/ui/input'

import { createInviteAction, revokeInviteAction } from '../api/manage-invites'

const ROLES = ['viewer', 'member', 'admin'] as const

function inviteLink(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  // Top-level route with no workspace slug — this is the entry point before joining a workspace.
  return `${origin}/invite?token=${encodeURIComponent(token)}`
}

export function InvitesManager({ invites, canWrite }: { invites: Invite[]; canWrite: boolean }) {
  const t = useTranslations('manageInvites')
  const locale = useLocale()
  const [role, setRole] = useState<string>('member')
  const [open, setOpen] = useState(false) // expand the create form — collapsed by default to hide the invite UI (role picker, etc.)
  const [link, setLink] = useState<string>() // the invite link just issued (once)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmId, setConfirmId] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onCreate() {
    setError(undefined)
    setLink(undefined)
    setCopied(false)
    startTransition(async () => {
      const r = await createInviteAction(role)
      if (r.ok && r.token) {
        setLink(inviteLink(r.token))
        setOpen(false) // collapse the form again after creating — the link is shown in the callout above.
      } else {
        setError(r.error ?? t('createFailed'))
      }
    })
  }

  function onRevoke(id: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await revokeInviteAction(id)
      setConfirmId(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  const pending2 = invites.filter((i) => !i.accepted)

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">{t('title')}</h3>
        {open && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t.rich('introRich', {
              strong: (chunks) => <span className="font-[510] text-foreground">{chunks}</span>,
            })}
          </p>
        )}
      </div>

      {/* The link just issued — revealed once */}
      {link && (
        <Callout tone="warning" hint={t('linkOnceHint')}>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{link}</code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void copyText(link, undefined, locale).then((ok) => ok && setCopied(true))
              }}
            >
              {copied ? t('copied') : t('copyLink')}
            </Button>
          </div>
        </Callout>
      )}

      {/* Pending invites list */}
      {pending2.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('noPending')}</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card shadow-raise">
          {pending2.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <span className="font-mono text-[13px]">{i.prefix}…</span>
                <span className="ml-2 text-[12px] text-faint">{i.role}</span>
                <span className="ml-2 text-[12px] text-faint">
                  {i.expiresAt
                    ? t('expiresAt', { date: new Date(i.expiresAt).toLocaleString(locale) })
                    : t('noExpiry')}
                </span>
              </div>
              {canWrite &&
                (confirmId === i.id ? (
                  <span className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => onRevoke(i.id)}
                    >
                      {t('revokeConfirm')}
                    </Button>
                    <button
                      type="button"
                      className="text-[12px] text-muted-foreground hover:text-foreground"
                      onClick={() => setConfirmId(undefined)}
                    >
                      {t('close')}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-destructive hover:underline"
                    onClick={() => setConfirmId(i.id)}
                  >
                    {t('revoke')}
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}

      {/* Create — just a button by default. Clicking it expands the role picker + create form (role UI hidden when not inviting). */}
      {canWrite ? (
        open ? (
          <div className="flex items-end gap-2.5">
            <div className="space-y-1.5">
              <Label htmlFor="invite-role">{t('role')}</Label>
              <Combobox
                id="invite-role"
                value={role}
                onChange={setRole}
                options={ROLES.map((r) => ({ value: r }))}
                className="w-32"
              />
            </div>
            <Button onClick={onCreate} disabled={pending}>
              {pending ? t('creating') : t('createLink')}
            </Button>
            <button
              type="button"
              className="self-end pb-2 text-[12px] text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              {t('close')}
            </button>
          </div>
        ) : (
          <Button
            type="button"
            onClick={() => {
              setOpen(true)
              setLink(undefined)
              setError(undefined)
            }}
          >
            {t('createInvite')}
          </Button>
        )
      ) : (
        <p className="text-[13px] text-muted-foreground">{t('adminRequired')}</p>
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
