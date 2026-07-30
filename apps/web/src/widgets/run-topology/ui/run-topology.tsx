'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import type { TopologyStatus } from '@everdict/contracts/wire'
import { Card } from '@/shared/ui/card'
import { SectionHeader } from '@/shared/ui/section-header'
import { cn } from '@/shared/lib/utils'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'cancelled'])
const POLL_MS = 5000

// 토폴로지 헬스 패널(런타임 디버깅, 서비스 하네스) — 웜 토폴로지의 서비스별 상태를 5초마다 폴링한다:
// 각 서비스의 상태·readiness·재시작 횟수·OOM 판정·최근 이벤트, 그리고 행별 로그 펼침(온디맨드 1회 fetch).
// 서비스 하네스가 아닌 run(found=false)은 첫 발견 전까지 통째로 숨긴다(빈 섹션 금지).
export function RunTopology({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const t = useTranslations('runTopology')
  const [topology, setTopology] = useState<TopologyStatus | null>(null)
  const [openLogs, setOpenLogs] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    if (TERMINAL.has(initialStatus)) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/topology`)
        if (res.ok) {
          const body = (await res.json()) as {
            status: string
            found: boolean
            topology: TopologyStatus | null
          }
          if (stopped) return
          if (body.found && body.topology) setTopology(body.topology)
          if (TERMINAL.has(body.status)) return // run 종료 — 마지막 로스터를 남기고 폴링 중단
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

  // 행별 로그 펼침 — 온디맨드 1회 fetch(폴링 아님), 다시 누르면 접힘.
  const toggleLogs = async (service: string) => {
    if (openLogs[service] !== undefined) {
      setOpenLogs((prev) => {
        const next = { ...prev }
        delete next[service]
        return next
      })
      return
    }
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/topology/${encodeURIComponent(service)}/logs`
      )
      if (!res.ok) return
      const body = (await res.json()) as { found: boolean; text: string }
      setOpenLogs((prev) => ({ ...prev, [service]: body.found ? body.text : t('noLogs') }))
    } catch {
      // best-effort — 로그 없음으로 둔다
    }
  }

  // 서비스 하네스가 아니거나 아직 첫 로스터 전 — 통째로 숨긴다.
  if (!topology) return null

  return (
    <div className="space-y-2.5">
      <SectionHeader title={t('title')} />
      <Card className="divide-y divide-border p-0">
        {!topology.deployed && (
          <p className="px-4 py-3 text-[12.5px] text-muted-foreground">{t('notDeployed')}</p>
        )}
        {topology.services.map((svc) => (
          <div key={svc.name} className="px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex size-2 rounded-full',
                  svc.ready
                    ? 'bg-[var(--color-success)]'
                    : svc.oom
                      ? 'bg-destructive'
                      : 'bg-[var(--color-warning)]'
                )}
              />
              <span className="font-mono text-[12.5px] font-medium">{svc.name}</span>
              <span className="text-[11.5px] text-faint">{svc.status}</span>
              {svc.oom && (
                <span className="rounded border border-destructive/40 px-1.5 py-0.5 font-mono text-[10.5px] text-destructive">
                  OOM
                </span>
              )}
              {svc.restarts !== undefined && svc.restarts > 0 && (
                <span className="rounded border border-[var(--color-warning)]/40 px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-warning)]">
                  {t('restarts', { count: svc.restarts })}
                </span>
              )}
              <button
                type="button"
                onClick={() => void toggleLogs(svc.name)}
                className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10.5px] text-faint transition-colors hover:bg-muted hover:text-muted-foreground"
              >
                {openLogs[svc.name] !== undefined ? t('hideLogs') : t('showLogs')}
              </button>
            </div>
            {svc.lastEvent && (
              <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80" title={svc.lastEvent}>
                {svc.lastEvent}
              </p>
            )}
            {openLogs[svc.name] !== undefined && (
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {openLogs[svc.name]}
              </pre>
            )}
          </div>
        ))}
      </Card>
    </div>
  )
}
