'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Switch } from '@/shared/ui/switch'

import { updateProductAction } from '../api/products'

// 자동 평가 스위치 — 즉시 적용(설정 규칙): 실패하면 로컬 상태를 되돌리고 이유를 토스트로 말한다.
export function AutoEvalToggle({
  productId,
  enabled,
  runtime,
}: {
  productId: string
  enabled: boolean
  runtime?: string
}) {
  const t = useTranslations('productPage')
  const refresh = useRefresh()
  const [on, setOn] = useState(enabled)
  const [pending, setPending] = useState(false)

  function toggle(next: boolean) {
    setOn(next)
    void (async () => {
      setPending(true)
      try {
        const r = await updateProductAction(productId, {
          autoEval: { enabled: next, ...(runtime !== undefined ? { runtime } : {}) },
        })
        if (!r.ok) {
          setOn(!next)
          toast.error(r.error ?? t('autoEvalError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
      {t('autoEval')}
      <Switch checked={on} onCheckedChange={toggle} disabled={pending} aria-label={t('autoEval')} />
    </label>
  )
}
