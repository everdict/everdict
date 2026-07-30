'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import type { CasePlacement } from '@everdict/contracts/wire'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { SectionHeader } from '@/shared/ui/section-header'
import { cn } from '@/shared/lib/utils'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'cancelled'])
const POLL_MS = 5000

// 배치 phase → 표시 색(시맨틱): blocked=경고, dead=위험, running=성공, 그 외=중립.
const PHASE_DOT: Record<CasePlacement['phase'], string> = {
  queued: 'bg-muted-foreground/60',
  blocked: 'bg-[var(--color-warning)]',
  starting: 'bg-primary',
  running: 'bg-[var(--color-success)]',
  dead: 'bg-destructive',
}

// 케이스 배치 패널(런타임 디버깅) — 케이스 잡이 클러스터 안에서 어디까지 갔는지 5초마다 폴링한다:
// queued(스케줄러 대기) · blocked(용량 부족 — 스케줄러의 판정문 표시) · starting(이미지 풀 등) · running · dead.
// 배치 정보가 아예 없는 run(셀프호스티드 레인·프리디스패치)은 첫 발견 전까지 통째로 숨긴다(빈 섹션 금지).
// run이 종료되면 폴링을 멈추고 마지막 읽기를 그대로 둔다.
export function RunPlacement({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const t = useTranslations('runPlacement')
  const [placement, setPlacement] = useState<CasePlacement | null>(null)

  useEffect(() => {
    if (TERMINAL.has(initialStatus)) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/placement`)
        if (res.ok) {
          const body = (await res.json()) as {
            status: string
            found: boolean
            placement: CasePlacement | null
          }
          if (stopped) return
          if (body.found && body.placement) setPlacement(body.placement)
          if (TERMINAL.has(body.status)) return // run 종료 — 마지막 읽기를 남기고 폴링 중단
        }
      } catch {
        // 일시 오류 — 폴링 지속
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [runId, initialStatus])

  // 배치 읽기가 아직/전혀 없는 run — 빈 박스 대신 통째로 숨긴다.
  if (!placement) return null

  const meta: Array<{ label: string; value: string }> = [
    ...(placement.node ? [{ label: t('node'), value: placement.node }] : []),
    ...(placement.unit ? [{ label: t('unit'), value: placement.unit }] : []),
    ...(placement.job ? [{ label: t('job'), value: placement.job }] : []),
    ...(placement.namespace ? [{ label: t('namespace'), value: placement.namespace }] : []),
    ...(placement.restarts !== undefined && placement.restarts > 0
      ? [{ label: t('restarts'), value: String(placement.restarts) }]
      : []),
  ]

  return (
    <div className="space-y-2.5">
      <SectionHeader title={t('title')} />
      <Card className="space-y-2.5 p-4">
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex size-2 rounded-full', PHASE_DOT[placement.phase])} />
          <span className="text-[13px] font-medium">{t(`phase.${placement.phase}`)}</span>
          {placement.oom && (
            <span className="rounded border border-destructive/40 px-1.5 py-0.5 font-mono text-[10.5px] text-destructive">
              OOM
            </span>
          )}
        </div>
        {placement.blockedReason && (
          <Callout tone="warning" hint={placement.blockedReason}>
            {t('blocked')}
          </Callout>
        )}
        {meta.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {meta.map((m) => (
              <div key={m.label} className="min-w-0">
                <dt className="text-[11px] text-faint">{m.label}</dt>
                <dd
                  className="truncate font-mono text-[11.5px] text-muted-foreground"
                  title={m.value}
                >
                  {m.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {placement.events.length > 0 && (
          <div className="max-h-48 space-y-0.5 overflow-auto rounded-lg border border-border bg-muted/40 p-2.5">
            {placement.events.map((e, i) => (
              <div
                key={`${e.at ?? ''}-${i}`}
                className="flex gap-2 font-mono text-[11px] leading-relaxed"
              >
                {e.at && <span className="shrink-0 text-faint">{e.at.slice(11, 19)}</span>}
                {e.type && <span className="shrink-0 text-muted-foreground">{e.type}</span>}
                <span className="min-w-0 break-all text-muted-foreground/80">{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
