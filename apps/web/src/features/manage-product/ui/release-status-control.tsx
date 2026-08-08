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

// 릴리즈 게이트의 UI 절반. "출하"가 409 로 거절되면 그 이유(열린 이슈 수·회귀한 시리즈)를 그대로 보여 주고,
// 강행은 별도의 명시적 확인을 거친다 — 기록되는 오버라이드지, 두 번 누르면 되는 버튼이 아니다.
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
  // 게이트가 거절한 이유 — 강행 확인 다이얼로그의 본문이 된다.
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

  // 나간 릴리즈는 역사다 — 되돌릴 수 있는 컨트롤 자체를 그리지 않는다.
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
