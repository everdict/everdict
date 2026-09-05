'use client'

import { useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { runProductSeriesAction } from '../api/products'

// Evaluate the watch series now — Sync's counterpart. Where Sync pulls the version axis (GitHub releases and tags), this button pulls the
// QUALITY axis. While it did not exist, "importing a new version" was the only trigger that ran a series, so declaring a new series on a product
// whose backfill was already done left the trend empty until the next upstream release.
//
// Used with no seriesKey it runs everything the product is currently watching; given one, that single series.
export function RunSeriesButton({
  productId,
  seriesKey,
  label,
}: {
  productId: string
  seriesKey?: string
  label?: string
}) {
  const t = useTranslations('productPage')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)

  function evaluate() {
    void (async () => {
      setPending(true)
      try {
        const r = await runProductSeriesAction(
          productId,
          seriesKey !== undefined ? [seriesKey] : undefined
        )
        if (!r.ok || !r.result) {
          toast.error(r.error ?? t('runSeriesError'))
          return
        }
        // Swallowing the series that could NOT be submitted reads as "we asked and got no answer at all" — a failure is stated at the same size as a success.
        if (r.result.failedSeries.length > 0) {
          toast.warning(
            t('runSeriesPartial', {
              triggered: r.result.triggered.length,
              failed: r.result.failedSeries.map((s) => `${s.key}: ${s.error}`).join(' · '),
            })
          )
        } else if (r.result.triggered.length === 0) {
          toast.info(t('runSeriesNone'))
        } else {
          toast.success(t('runSeriesDone', { triggered: r.result.triggered.length }))
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <Button variant="outline" size="sm" onClick={evaluate} disabled={pending}>
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
      {label ?? t('runSeriesNow')}
    </Button>
  )
}
