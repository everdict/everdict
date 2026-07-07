'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

import { acceptInviteAction } from '../api/accept-invite'

// 초대 수락 카드. GET 자동 수락을 피하려 명시적 버튼(POST 서버 액션)으로만 redeem — prefetch 가 일회용 토큰을 소진하지 않게.
export function AcceptInviteCard({ token }: { token: string }) {
  const t = useTranslations('acceptInvite')
  const router = useRouter()
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<{ workspace: string; role: string }>()
  const [pending, startTransition] = useTransition()

  function onAccept() {
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
  }

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

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t('description')}</p>
      <div className="flex items-center gap-2.5">
        <Button onClick={onAccept} disabled={pending}>
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
