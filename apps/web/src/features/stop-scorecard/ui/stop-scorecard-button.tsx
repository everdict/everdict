'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CircleStop } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { stopScorecardAction } from '../api/stop-scorecard'

// Stop button for a running/queued scorecard. Two-step confirm (stopping frees the runtime and can't be undone),
// then calls the server action; on success it refreshes so the header shows the new `cancelled` status.
export function StopScorecardButton({ id }: { id: string }) {
  const t = useTranslations('scorecardsPage')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string>()

  function stop() {
    setError(undefined)
    start(async () => {
      const res = await stopScorecardAction(id)
      if (res.ok) {
        setConfirming(false)
        router.refresh()
      } else {
        setError(res.error ?? t('stopError'))
      }
    })
  }

  if (!confirming)
    return (
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        <CircleStop className="size-4" />
        {t('stopButton')}
      </Button>
    )

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-[12px] text-destructive">{error}</span>}
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>
        {t('stopKeep')}
      </Button>
      <Button variant="destructive" size="sm" onClick={stop} disabled={pending}>
        {pending ? t('stopping') : t('stopConfirm')}
      </Button>
    </div>
  )
}
