'use client'

import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { syncProductAction } from '../api/products'

// 지금 GitHub 을 당긴다 — everdict 는 클라이언트라 웹훅이 없고, 이 버튼이 타임라인의 새로고침이다.
// 결과는 서비스별로 요약해 토스트로: 몇 개가 들어왔고, 어느 레포가 닿지 않았는지.
export function SyncProductButton({ productId }: { productId: string }) {
  const t = useTranslations('productsPage')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)

  function sync() {
    void (async () => {
      setPending(true)
      try {
        const r = await syncProductAction(productId)
        if (!r.ok || !r.result) {
          toast.error(r.error ?? t('syncError'))
          return
        }
        const imported = r.result.services.reduce((sum, s) => sum + s.imported, 0)
        const failed = r.result.services.filter((s) => s.error !== undefined)
        if (failed.length > 0) {
          toast.warning(t('syncPartial', { imported, failed: failed.map((s) => s.name).join(', ') }))
        } else if (r.result.triggered.length > 0) {
          toast.success(t('syncDoneTriggered', { imported, triggered: r.result.triggered.length }))
        } else {
          toast.success(t('syncDone', { imported }))
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <Button variant="outline" size="sm" onClick={sync} disabled={pending}>
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
      {t('syncNow')}
    </Button>
  )
}
