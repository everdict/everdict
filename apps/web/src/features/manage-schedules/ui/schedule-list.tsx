'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import type { Schedule } from '@/entities/schedule'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

import { deleteScheduleAction, setScheduleEnabledAction } from '../api/schedule-actions'

// 예약 목록 — pause/resume(enabled 토글) + 삭제. 발사 자체는 컨트롤플레인(Temporal)이 한다.
export function ScheduleList({
  schedules,
  canWrite,
}: {
  schedules: Schedule[]
  canWrite: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()

  function act(fn: () => Promise<{ ok: boolean; error?: string }>): void {
    setError(undefined)
    startTransition(async () => {
      const res = await fn()
      if (res.ok) router.refresh()
      else setError(res.error ?? '작업 실패')
    })
  }

  return (
    <div className="space-y-2">
      {error && <Callout tone="danger">{error}</Callout>}
      {schedules.map((s) => (
        <div
          key={s.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise"
        >
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-[510] text-[14px]">{s.name}</span>
              <Badge tone={s.enabled ? 'success' : 'neutral'}>
                {s.enabled ? '활성' : '일시중지'}
              </Badge>
              <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground">
                {s.cron} · {s.timezone}
              </code>
            </div>
            <div className="flex flex-wrap items-center gap-x-1 font-mono text-[12px] text-muted-foreground">
              {s.runTemplate.dataset.id}
              <span className="text-faint">@{s.runTemplate.dataset.version}</span>
              <span className="px-1">→</span>
              {s.runTemplate.harness.id}
              <span className="text-faint">@{s.runTemplate.harness.version}</span>
              {s.lastStatus ? (
                <span className="ml-2 text-faint">
                  · 최근 {s.lastStatus}
                  {s.lastFiredAt ? ` (${new Date(s.lastFiredAt).toLocaleString()})` : ''}
                </span>
              ) : null}
            </div>
          </div>
          {canWrite ? (
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => act(() => setScheduleEnabledAction(s.id, !s.enabled))}
              >
                {s.enabled ? '일시중지' : '재개'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => act(() => deleteScheduleAction(s.id))}
              >
                삭제
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
