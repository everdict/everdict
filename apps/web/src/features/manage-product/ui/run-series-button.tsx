'use client'

import { useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { runProductSeriesAction } from '../api/products'

// 워치 시리즈를 지금 평가한다 — Sync 의 짝이다. Sync 가 버전 축(GitHub 릴리즈/태그)을 당긴다면 이 버튼은
// 품질 축을 당긴다. 이게 없던 동안에는 "새 버전 임포트"만이 시리즈를 돌리는 유일한 계기여서, 이미 백필이
// 끝난 프로덕트에 시리즈를 새로 선언하면 다음 업스트림 릴리즈까지 추이가 비어 있었다.
//
// seriesKey 없이 쓰면 프로덕트가 지금 지켜보는 전부, 주면 그 시리즈 하나.
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
        // 제출되지 못한 시리즈를 삼키면 "물어봤는데 아무 답도 없었다"로 읽힌다 — 실패는 성공과 같은 크기로 말한다.
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
