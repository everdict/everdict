'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { RotateCcw } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { retryFailedCasesAction } from '../api/retry-failed-cases'

// Retry-failed button for a TERMINAL scorecard that has failed cases — the recovery lever once a runner is healthy
// again (a no_runner / infra casualty re-runs; passing cases carry over verbatim). Not destructive (it creates a NEW
// scorecard), so it is a single click; on success it navigates to the fresh run. Workspace-relative so it stays under
// the active-workspace URL prefix.
export function RetryFailedButton({ id, workspace }: { id: string; workspace: string }) {
  const t = useTranslations('scorecardsPage')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string>()

  function retry() {
    setError(undefined)
    start(async () => {
      const res = await retryFailedCasesAction(id)
      if (res.ok && res.id) router.push(`/${workspace}/scorecards/${res.id}`)
      else setError(res.error ?? t('retryError'))
    })
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-[12px] text-destructive">{error}</span>}
      <Button variant="outline" size="sm" onClick={retry} disabled={pending}>
        <RotateCcw className="size-4" />
        {pending ? t('retrying') : t('retryButton')}
      </Button>
    </div>
  )
}
