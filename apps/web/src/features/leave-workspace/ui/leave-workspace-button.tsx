'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

import { leaveWorkspaceAction } from '../api/leave-workspace'

// Leave this workspace — Linear "Workspace access" pattern (description left · action right).
// Two-step confirmation (misclick prevention). On success, redirect to home (/) to re-route to a remaining workspace/onboarding.
// The last admin is blocked by the control plane with 409, and that message is shown inline.
export function LeaveWorkspaceButton() {
  const t = useTranslations('leaveWorkspace')
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, startTransition] = useTransition()

  function onLeave() {
    setError(undefined)
    startTransition(async () => {
      const r = await leaveWorkspaceAction()
      if (r.ok) {
        router.push('/')
        router.refresh()
      } else {
        setConfirming(false)
        setError(r.error ?? t('leaveFailed'))
      }
    })
  }

  return (
    <div className="space-y-2.5">
      <h3 className="px-1 text-[13px] font-[560] text-foreground">{t('sectionTitle')}</h3>
      <SettingsList>
        <SettingsRow label={t('leaveRowLabel')}>
          {confirming ? (
            <>
              <button
                type="button"
                className="text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => setConfirming(false)}
                disabled={pending}
              >
                {t('cancel')}
              </button>
              <Button variant="destructive" size="sm" onClick={onLeave} disabled={pending}>
                {pending ? t('leaving') : t('confirmLeave')}
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
              {t('leave')}
            </Button>
          )}
        </SettingsRow>
      </SettingsList>
      {error && <Callout tone="danger">{error}</Callout>}
    </div>
  )
}
