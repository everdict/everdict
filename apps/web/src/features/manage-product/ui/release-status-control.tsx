'use client'

import { useState } from 'react'
import { CircleSlash, Loader2, Rocket, Undo2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { ReleaseStatus } from '@/entities/product'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'

import { setReleaseStatusAction } from '../api/products'

// The UI half of the release gate. When "ship" is refused with a 409, the REASON (the open issue count, the regressed series) is shown verbatim,
// and forcing goes through a separate explicit confirmation — it is a RECORDED override, not a button you press twice.
export function ReleaseStatusControl({
  releaseId,
  status,
}: {
  releaseId: string
  status: ReleaseStatus
}) {
  const t = useTranslations('releasePage')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)
  // Why the gate refused — it becomes the body of the force confirmation dialog.
  const [blockedReason, setBlockedReason] = useState<string | null>(null)

  function move(to: ReleaseStatus, force?: boolean) {
    void (async () => {
      setPending(true)
      try {
        const r = await setReleaseStatusAction(releaseId, to, force)
        if (!r.ok) {
          if (r.blocked && to === 'released' && !force) {
            setBlockedReason(r.error ?? t('gateBlockedFallback'))
            return
          }
          toast.error(r.error ?? t('statusError'))
          return
        }
        setBlockedReason(null)
        if (to === 'released') toast.success(force ? t('shippedForced') : t('shipped'))
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  // A shipped release is HISTORY — no control that could undo it is drawn at all.
  if (status === 'released') return null

  return (
    <div className="flex items-center gap-2">
      {status === 'planned' && (
        <>
          <Button size="sm" onClick={() => move('released')} disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
            {t('ship')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => move('cancelled')} disabled={pending}>
            <CircleSlash className="size-3.5" />
            {t('cancelRelease')}
          </Button>
        </>
      )}
      {status === 'cancelled' && (
        <Button variant="outline" size="sm" onClick={() => move('planned')} disabled={pending}>
          <Undo2 className="size-3.5" />
          {t('replan')}
        </Button>
      )}
      <Dialog open={blockedReason !== null} onClose={() => setBlockedReason(null)} className="max-w-md">
        <div className="space-y-4 p-5">
          <h2 className="text-sm font-semibold">{t('gateBlockedTitle')}</h2>
          <p className="text-sm text-muted-foreground">{blockedReason}</p>
          <p className="text-xs text-muted-foreground">{t('gateForceHint')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setBlockedReason(null)}>
              {t('gateKeepWorking')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => move('released', true)} disabled={pending}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t('gateForceShip')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
