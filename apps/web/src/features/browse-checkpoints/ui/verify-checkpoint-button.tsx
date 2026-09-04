'use client'

import { useState, useTransition } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { verifyCheckpointAction } from '../api/verify-checkpoint'

// Ask an independent verifier to check a handoff. No confirm: the verifier runs in an evidence-only
// envelope, so the act cannot change anything except what is known.
export function VerifyCheckpointButton({ id, verified }: { id: string; verified: boolean }) {
  const t = useTranslations('checkpointsPage')
  const refresh = useRefresh()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string>()

  return (
    <span className="inline-flex items-center gap-2">
      {error !== undefined && <span className="text-[12px] text-destructive">{error}</span>}
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        title={t('verifyTitle')}
        onClick={() => {
          setError(undefined)
          start(async () => {
            const res = await verifyCheckpointAction(id)
            if (res.ok) refresh()
            else setError(res.error ?? t('verifyError'))
          })
        }}
      >
        <ShieldCheck className="size-4" /> {verified ? t('verifyAgain') : t('verify')}
      </Button>
    </span>
  )
}
