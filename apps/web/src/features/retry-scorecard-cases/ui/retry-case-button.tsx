'use client'

import { useState, useTransition } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { retryScorecardCasesAction } from '../api/retry-scorecard-cases'

// Re-run ONE case inside the scorecard being viewed. Unlike the re-score beside it, this spends compute and
// rewrites what the batch says about this case — so a case that already reached a verdict asks for a reason
// first, and the control plane refuses without one rather than trusting this component to have asked.
export function RetryCaseButton({
  id,
  caseId,
  trial,
  needsReason,
  attempts,
}: {
  id: string
  caseId: string
  trial?: number
  // Whether this case reached a real verdict. The server decides — this only decides whether to PROMPT, so
  // a stale page cannot smuggle a verdict replacement past the refusal.
  needsReason: boolean
  attempts: number
}) {
  const t = useTranslations('scorecardsPage')
  const refresh = useRefresh()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string>()

  function retry() {
    setError(undefined)
    // An empty prompt is a CANCEL, not an empty reason: sending one would ask the control plane to refuse
    // something the reader already declined. Narrowed before the closure so the send site cannot be handed
    // a `null` that reads as "no reason needed".
    let reason: string | undefined
    if (needsReason) {
      const answer = window.prompt(t('retryCaseReasonPrompt'))
      if (answer === null || answer.trim() === '') return
      reason = answer
    }
    start(async () => {
      const res = await retryScorecardCasesAction(
        id,
        [trial === undefined ? { caseId } : { caseId, trial }],
        reason,
      )
      if (res.ok) refresh()
      else setError(res.error ?? t('retryCaseError'))
    })
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-[12px] text-destructive">{error}</span>}
      {attempts > 1 && (
        <span className="text-[12px] text-muted-foreground" title={t('retryCaseAttemptsTitle', { attempts })}>
          {t('retryCaseAttempts', { attempts })}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={retry}
        disabled={pending}
        title={needsReason ? t('retryCaseTitleDecided') : t('retryCaseTitle')}
      >
        <RefreshCw className="size-4" />
      </Button>
    </span>
  )
}
