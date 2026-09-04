'use client'

import { useState, useTransition } from 'react'
import { FileCheck, FileText, ShieldAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import {
  overrideScorecardGateAction,
  scorecardReportAction,
  verifyScorecardManifestAction,
} from '../api/scorecard-evidence'

// Two acts a settled scorecard owes a reader: prove it is still what it claims, and let somebody override a
// block on the record rather than in a conversation.
export function ScorecardEvidenceActions({ id, blocked }: { id: string; blocked: boolean }) {
  const t = useTranslations('scorecardsPage')
  const refresh = useRefresh()
  const [busy, start] = useTransition()
  const [verdict, setVerdict] = useState<string>()
  const [report, setReport] = useState<string>()
  const [error, setError] = useState<string>()

  function verify() {
    setError(undefined)
    setVerdict(undefined)
    start(async () => {
      const res = await verifyScorecardManifestAction(id)
      if (!res.ok) {
        setError(res.error ?? t('verifyManifestError'))
        return
      }
      // Three answers. `unverifiable` is NOT a failure — it says the check could not run, and reporting it
      // as a mismatch would accuse a batch nobody read.
      setVerdict(t(`verifyManifest.${res.verdict ?? 'unverifiable'}`))
    })
  }

  function openReport() {
    setError(undefined)
    start(async () => {
      const res = await scorecardReportAction(id)
      if (res.ok) setReport(res.markdown ?? '')
      else setError(res.error ?? t('reportError'))
    })
  }

  function override() {
    setError(undefined)
    const reason = window.prompt(t('overrideGatePrompt'))
    // An empty reason is a CANCEL. The control plane requires one, and an override that leaves no artifact
    // overrides nothing.
    if (reason === null || reason.trim() === '') return
    start(async () => {
      const res = await overrideScorecardGateAction(id, reason.trim())
      if (res.ok) refresh()
      else setError(res.error ?? t('overrideGateError'))
    })
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error !== undefined && <span className="text-[12px] text-destructive">{error}</span>}
      {verdict !== undefined && <span className="text-[12px] text-muted-foreground">{verdict}</span>}
      <Button variant="ghost" size="sm" onClick={openReport} disabled={busy} title={t('reportTitle')}>
        <FileText className="size-4" /> {t('reportOpen')}
      </Button>
      <Button variant="ghost" size="sm" onClick={verify} disabled={busy} title={t('verifyManifestTitle')}>
        <FileCheck className="size-4" /> {t('verifyManifest.action')}
      </Button>
      {/* Only when there IS a block to override. A permanent button would invite one on a green batch. */}
      {blocked && (
        <Button variant="outline" size="sm" onClick={override} disabled={busy} title={t('overrideGateTitle')}>
          <ShieldAlert className="size-4" /> {t('overrideGate')}
        </Button>
      )}
      {/* The report is shown where it was asked for rather than on a route of its own: it is a document to
          read or copy, and a page transition would lose the batch it is about. */}
      {report !== undefined && (
        <pre className="mt-2 max-h-96 w-full overflow-auto whitespace-pre-wrap rounded-md border border-border/60 p-3 text-[12px]">
          {report}
        </pre>
      )}
    </span>
  )
}
