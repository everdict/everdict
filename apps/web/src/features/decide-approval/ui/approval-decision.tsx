'use client'

import { useState, useTransition } from 'react'
import { Check, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { decideApprovalAction } from '../api/decide-approval'

// Approve or deny one parked agent mutation. Both buttons go through the SAME action and the same refusal
// path — a deny is not a local dismissal, it is a decision the agent is waiting on, and a page that treated
// it as a UI state would leave the session parked forever.
export function ApprovalDecision({ id, pending: isPending }: { id: string; pending: boolean }) {
  const t = useTranslations('approvalsPage')
  const refresh = useRefresh()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string>()

  function decide(decision: 'approve' | 'deny') {
    setError(undefined)
    start(async () => {
      const res = await decideApprovalAction(id, decision)
      if (res.ok) refresh()
      else setError(res.error ?? t('decideError'))
    })
  }

  // A decided or expired approval keeps its row and loses its buttons: the queue is a record of what was
  // asked and answered, not a worklist that empties.
  if (!isPending) return null

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-[12px] text-destructive">{error}</span>}
      <Button variant="outline" size="sm" onClick={() => decide('approve')} disabled={busy}>
        <Check className="size-4" /> {t('approve')}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => decide('deny')} disabled={busy}>
        <X className="size-4" /> {t('deny')}
      </Button>
    </span>
  )
}
