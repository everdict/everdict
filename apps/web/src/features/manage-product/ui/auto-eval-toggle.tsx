'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Switch } from '@/shared/ui/switch'

import { updateProductAction } from '../api/products'

// The automatic-evaluation switch — applied immediately (the settings rule): on failure it rolls the local state back and states the reason as a toast.
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
