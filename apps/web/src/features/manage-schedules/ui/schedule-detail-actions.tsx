'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Pause, Pencil, Play, Trash2, Zap } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button, buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'

import {
  deleteScheduleAction,
  fireScheduleAction,
  setScheduleEnabledAction,
} from '../api/schedule-actions'

// 예약 상세 헤더의 액션 묶음 — 지금 실행 · 일시중지/재개 · 편집 · 삭제.
// 상태 토글은 목록 카드의 StateIcon+드롭다운 대신, 상세에서는 라벨 버튼(발견성 우선, judge 상세와 동형).
// 권한은 모두 컨트롤 플레인이 최종 강제 — 여기서는 노출만 제어한다.
export function ScheduleDetailActions({
  workspace,
  id,
  enabled,
  canWrite,
  canEdit,
}: {
  workspace: string
  id: string
  enabled: boolean
  canWrite: boolean // 지금 실행 · 토글 · 삭제 (member+)
  canEdit: boolean // 편집 (생성자 or admin)
}) {
  const router = useRouter()
  const t = useTranslations('scheduleDetail')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const onFire = () =>
    startTransition(async () => {
      setError(undefined)
      const res = await fireScheduleAction(id)
      if (res.ok && res.scorecardId)
        router.push(`/${workspace}/scorecards/${encodeURIComponent(res.scorecardId)}`)
      else setError(res.error ?? t('actionFailed'))
    })

  const onToggle = () =>
    startTransition(async () => {
      setError(undefined)
      const res = await setScheduleEnabledAction(id, !enabled)
      if (res.ok) router.refresh()
      else setError(res.error ?? t('actionFailed'))
    })

  const onDelete = () =>
    startTransition(async () => {
      setError(undefined)
      const res = await deleteScheduleAction(id)
      if (res.ok) router.push(`/${workspace}/schedules`)
      else {
        setError(res.error ?? t('actionFailed'))
        setConfirmingDelete(false)
      }
    })

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {canWrite && (
          <Button variant="primary" size="sm" onClick={onFire} disabled={pending}>
            <Zap />
            {t('runNow')}
          </Button>
        )}
        {canWrite && (
          <Button variant="secondary" size="sm" onClick={onToggle} disabled={pending}>
            {enabled ? <Pause /> : <Play />}
            {enabled ? t('pause') : t('resume')}
          </Button>
        )}
        {canEdit && (
          <Link
            href={`/${workspace}/schedules/${encodeURIComponent(id)}/edit`}
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            <Pencil />
            {t('edit')}
          </Link>
        )}
        {canWrite && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmingDelete(true)}
            disabled={pending}
            className="text-muted-foreground hover:text-[var(--color-danger)]"
          >
            <Trash2 />
            {t('delete')}
          </Button>
        )}
      </div>
      {error && (
        <Callout tone="danger" className="max-w-md text-left">
          {error}
        </Callout>
      )}

      <Dialog open={confirmingDelete} onClose={() => setConfirmingDelete(false)}>
        <div className="w-full max-w-md space-y-4 p-5">
          <div className="space-y-1.5">
            <h2 className="text-[15px] font-[560]">{t('deleteConfirmTitle')}</h2>
            <p className="text-[13px] text-muted-foreground">{t('deleteConfirmBody')}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmingDelete(false)}
              disabled={pending}
            >
              {t('cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={onDelete} disabled={pending}>
              {t('delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
