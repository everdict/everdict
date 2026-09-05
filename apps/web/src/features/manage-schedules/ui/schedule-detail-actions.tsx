'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pause, Pencil, Play, Trash2, Zap } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { Link } from '@/shared/ui/link'

import {
  deleteScheduleAction,
  fireScheduleAction,
  setScheduleEnabledAction,
} from '../api/schedule-actions'

// The action group in the schedule detail header — run now · pause/resume · edit · delete.
// The state toggle is a LABELLED button on the detail rather than the list card's StateIcon + dropdown (discoverability first, isomorphic to the judge detail).
// Every permission is enforced finally by the control plane — only the VISIBILITY is controlled here.
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
  canWrite: boolean // run now · toggle · delete (member+)
  canEdit: boolean // edit (the creator or an admin)
}) {
  const router = useRouter()
  const refresh = useRefresh()
  const t = useTranslations('scheduleDetail')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const onFire = () =>
    void (async () => {
      setPending(true)
      try {
        setError(undefined)
        const res = await fireScheduleAction(id)
        if (res.ok && res.scorecardId)
          router.push(`/${workspace}/scorecard/${encodeURIComponent(res.scorecardId)}`)
        else setError(res.error ?? t('actionFailed'))
      } finally {
        setPending(false)
      }
    })()

  const onToggle = () =>
    void (async () => {
      setPending(true)
      try {
        setError(undefined)
        const res = await setScheduleEnabledAction(id, !enabled)
        if (res.ok) refresh()
        else setError(res.error ?? t('actionFailed'))
      } finally {
        setPending(false)
      }
    })()

  const onDelete = () =>
    void (async () => {
      setPending(true)
      try {
        setError(undefined)
        const res = await deleteScheduleAction(id)
        if (res.ok) router.push(`/${workspace}/schedules`)
        else {
          setError(res.error ?? t('actionFailed'))
          setConfirmingDelete(false)
        }
      } finally {
        setPending(false)
      }
    })()

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
            href={`/${workspace}/schedule/${encodeURIComponent(id)}/edit`}
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
