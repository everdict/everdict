'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

import { acceptInviteAction } from '../api/accept-invite'

// Invite acceptance card. To avoid auto-accepting on GET, redeem only via an explicit button (POST server action) — so a prefetch never joins on its own (the link is reusable, but a silent prefetch-join would still be surprising).
// Signed out → the primary action becomes "sign in" (a full-page redirect to Keycloak) carrying a callbackUrl back to this page with `autoAccept=1`,
// so login returns here and the token is redeemed automatically — a friendly one-hop flow instead of a dead-end 401.
export function AcceptInviteCard({
  token,
  authenticated,
  autoAccept,
}: {
  token: string
  authenticated: boolean
  autoAccept: boolean
}) {
  const t = useTranslations('acceptInvite')
  const router = useRouter()
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<{ workspace: string; role: string }>()
  const [pending, startTransition] = useTransition()

  const accept = useCallback(() => {
    setError(undefined)
    startTransition(async () => {
      const r = await acceptInviteAction(token)
      if (r.ok && r.workspace && r.role) {
        setDone({ workspace: r.workspace, role: r.role })
        router.refresh()
      } else {
        setError(r.error ?? t('acceptFailed'))
      }
    })
  }, [token, router, t])

  // Post-login landing: the sign-in callbackUrl carried `autoAccept=1`, so redeem once, automatically.
  // Strip the marker first (history.replaceState — a shallow URL rewrite, no navigation) so a manual refresh doesn't re-submit (harmless now, but avoids a redundant join round-trip).
  const autoFired = useRef(false)
  useEffect(() => {
    if (!autoAccept || !authenticated || autoFired.current) return
    autoFired.current = true
    window.history.replaceState(null, '', `/invite?token=${encodeURIComponent(token)}`)
    accept()
  }, [autoAccept, authenticated, token, accept])

  if (done) {
    return (
      <div className="space-y-4">
        <Callout tone="info">
          <span className="font-[510]">
            {t.rich('joined', {
              workspace: done.workspace,
              role: done.role,
              ws: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </span>
        </Callout>
        <Button onClick={() => router.push(`/${done.workspace}`)}>{t('goToWorkspace')}</Button>
      </div>
    )
  }

  // Signed out → send to Keycloak login, returning here with the autoAccept marker so the invite is redeemed right after login.
  if (!authenticated) {
    const callbackUrl = `/invite?token=${encodeURIComponent(token)}&autoAccept=1`
    const signInHref = `/api/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`
    return (
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t('signInDescription')}
        </p>
        <div className="flex items-center gap-2.5">
          <Button
            onClick={() => {
              window.location.href = signInHref
            }}
          >
            {t('signInToAccept')}
          </Button>
          <Button variant="secondary" onClick={() => router.push('/')}>
            {t('cancel')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t('description')}</p>
      <div className="flex items-center gap-2.5">
        <Button onClick={accept} disabled={pending}>
          {pending ? t('accepting') : t('accept')}
        </Button>
        <Button variant="secondary" onClick={() => router.push('/')} disabled={pending}>
          {t('cancel')}
        </Button>
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
    </div>
  )
}
