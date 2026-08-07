'use client'

import { useState, useTransition } from 'react'
import { RotateCcw } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { rescoreScorecardAction } from '../api/rescore-scorecard'

// Recover transient scoring failures in place: shown only when the served detail carries a
// retryableUnmeasured count (> 0). Non-destructive (judge rows are REPLACED under the batch's own pins, no
// case re-runs), so no confirm step — one click, then refresh shows the recovered verdicts.
export function RescoreScorecardButton({ id, count }: { id: string; count: number }) {
  const t = useTranslations('scorecardsPage')
  const refresh = useRefresh()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string>()

  function rescore() {
    setError(undefined)
    start(async () => {
      const res = await rescoreScorecardAction(id)
      if (res.ok) refresh()
      else setError(res.error ?? t('rescoreError'))
    })
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-[12px] text-destructive">{error}</span>}
      <Button
        variant="outline"
        size="sm"
        onClick={rescore}
        disabled={pending}
        title={t('rescoreTitle', { count })}
      >
        <RotateCcw className="size-4" />
        {pending ? t('rescoring') : t('rescoreButton', { count })}
      </Button>
    </span>
  )
}
