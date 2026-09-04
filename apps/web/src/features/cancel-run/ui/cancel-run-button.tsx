'use client'

import { useState, useTransition } from 'react'
import { Square } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { cancelRunAction } from '../api/cancel-run'

// Stop a run from the page of the person watching it. Shown only while the run can still be stopped — a
// terminal run's button would be a control that only ever answers 409, which teaches people the page lies.
export function CancelRunButton({ id, status }: { id: string; status: string }) {
  const t = useTranslations('runsPage')
  const refresh = useRefresh()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string>()

  if (status !== 'queued' && status !== 'running' && status !== 'suspended') return null

  function cancel() {
    setError(undefined)
    // Stopping spends nothing and un-stops nothing: a cancelled run is terminal, and the confirm is what
    // stands between a mis-click and evidence that has to be produced again.
    if (!window.confirm(t('cancelConfirm'))) return
    start(async () => {
      const res = await cancelRunAction(id)
      if (res.ok) refresh()
      else setError(res.error ?? t('cancelError'))
    })
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-[12px] text-destructive">{error}</span>}
      <Button variant="outline" size="sm" onClick={cancel} disabled={busy} title={t('cancelTitle')}>
        <Square className="size-4" /> {t('cancel')}
      </Button>
    </span>
  )
}
