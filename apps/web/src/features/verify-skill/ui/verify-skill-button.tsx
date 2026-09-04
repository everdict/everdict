'use client'

import { useState, useTransition } from 'react'
import { BadgeCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { verifySkillAction } from '../api/verify-skill'

// Attest that a skill still holds — the act that turns "true when written" into "checked on a date".
export function VerifySkillButton({ id }: { id: string }) {
  const t = useTranslations('skillsManager')
  const refresh = useRefresh()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string>()

  function verify() {
    setError(undefined)
    start(async () => {
      const res = await verifySkillAction(id)
      if (res.ok) refresh()
      else setError(res.error ?? t('verifyError'))
    })
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error !== undefined && <span className="text-[12px] text-destructive">{error}</span>}
      <Button variant="outline" size="sm" onClick={verify} disabled={busy} title={t('verifyTitle')}>
        <BadgeCheck className="size-4" /> {t('verify')}
      </Button>
    </span>
  )
}
