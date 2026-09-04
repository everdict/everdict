'use client'

import { useState, useTransition } from 'react'
import { ShieldQuestion } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'

import { gateScorecardsAction, type GateResult } from '../api/gate-scorecards'

// Rehearse the release gate on the pair already being compared. It answers the same four ways CI does, and
// they are drawn differently on purpose: only `pass` is a green light, and the two that are neither pass nor
// block say something a single red badge would erase.
export function GateButton({ baseline, candidate }: { baseline?: string; candidate?: string }) {
  const t = useTranslations('scorecardsPage')
  const [result, setResult] = useState<GateResult>()
  const [busy, start] = useTransition()

  // The PAIR is the question. A gate over "some candidate" is not a decision.
  if (baseline === undefined || candidate === undefined) return null

  const tone =
    result?.outcome === 'pass'
      ? 'success'
      : result?.outcome === 'block'
        ? 'danger'
        : result?.outcome === undefined
          ? 'neutral'
          : 'warning'

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        title={t('gateTitle')}
        onClick={() => start(async () => setResult(await gateScorecardsAction(baseline, candidate)))}
      >
        <ShieldQuestion className="size-4" /> {t('gate')}
      </Button>
      {result?.ok === false && <span className="text-[12px] text-destructive">{t('gateError')}</span>}
      {result?.ok === true && result.outcome !== undefined && (
        <Badge tone={tone}>{t(`gateOutcome.${result.outcome}`)}</Badge>
      )}
      {result?.reason !== undefined && (
        <span className="text-[12px] text-muted-foreground">{result.reason}</span>
      )}
    </span>
  )
}
