'use client'

import { useState, useTransition } from 'react'
import { Calculator } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { estimateScorecardAction, type EstimateResult } from '../api/estimate-scorecard'

// What this batch is likely to cost, before submitting it. Asked on demand rather than on every keystroke:
// the estimate reads history for a dataset×harness pair, and re-reading it per character would spend the
// control plane's time on a form nobody has finished filling in.
export function EstimateLine({ dataset, harness }: { dataset?: string; harness?: string }) {
  const t = useTranslations('scorecardsPage')
  const [busy, start] = useTransition()
  const [result, setResult] = useState<EstimateResult>()

  // The pair IS the query — an estimate for "some dataset" is not a number, it is a guess with a currency
  // symbol on it.
  if (dataset === undefined || harness === undefined || dataset === '' || harness === '') return null

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => start(async () => setResult(await estimateScorecardAction({ dataset, harness })))}
      >
        <Calculator className="size-4" /> {t('estimate')}
      </Button>
      {result?.ok === false && <span className="text-[12px] text-destructive">{t('estimateError')}</span>}
      {/* NO HISTORY IS A REAL ANSWER. Printing $0 for a pair nobody has run would be inventing a number,
          and the route goes out of its way to say `samples: 0` rather than guess one. */}
      {result?.ok === true && (result.samples ?? 0) === 0 && (
        <span className="text-[12px] text-muted-foreground">{t('estimateNoHistory')}</span>
      )}
      {result?.ok === true && (result.samples ?? 0) > 0 && (
        <span className="text-[12px] text-muted-foreground">
          {t('estimateValue', {
            usd: (result.usd ?? 0).toFixed(2),
            minutes: Math.round((result.seconds ?? 0) / 60),
            samples: result.samples ?? 0,
          })}
        </span>
      )}
    </div>
  )
}
