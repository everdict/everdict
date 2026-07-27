'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Pause, Play, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import {
  deleteReportScheduleAction,
  fireReportScheduleAction,
  setReportScheduleEnabledAction,
} from '../api/report-schedule-actions'

// Row controls for one report schedule — run now (a synchronous headless agent turn, so the button shows a
// running state for its whole duration), pause/resume, delete. Errors surface inline under the row.
export function ReportScheduleRowActions({
  schedule,
}: {
  schedule: { id: string; enabled: boolean }
}) {
  const t = useTranslations('viewReportSchedule')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | undefined>(undefined)

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      setError(undefined)
      const res = await fn()
      if (!res.ok) setError(res.error ?? t('actionFailed'))
      else router.refresh()
    })

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => act(() => fireReportScheduleAction(schedule.id))}
        >
          {pending ? t('running') : t('runNow')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          aria-label={schedule.enabled ? t('pause') : t('resume')}
          onClick={() => act(() => setReportScheduleEnabledAction(schedule.id, !schedule.enabled))}
        >
          {schedule.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          aria-label={t('remove')}
          onClick={() => act(() => deleteReportScheduleAction(schedule.id))}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      {error && <p className="max-w-64 truncate text-xs text-destructive">{error}</p>}
    </div>
  )
}
