'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import type { TopologyStatus } from '@everdict/contracts/wire'
import { fmtDurationMs } from '@/shared/lib/format'
import { Card } from '@/shared/ui/card'
import { SectionHeader } from '@/shared/ui/section-header'
import { cn } from '@/shared/lib/utils'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'cancelled'])
const POLL_MS = 5000

// 토폴로지 헬스 패널(런타임 디버깅, 서비스 하네스) — 웜 토폴로지의 서비스별 상세를 5초마다 폴링한다:
// 선언 정체성(role·이미지·포트)과 라이브 상태(상태·readiness·재시작·OOM·노드·리소스·age·엔드포인트)를
// 서비스별 행으로, 펼치면 오케스트레이터 이벤트 피드+로그 테일(온디맨드 1회 fetch)까지.
// 서비스 하네스가 아닌 run(found=false)은 첫 발견 전까지 통째로 숨긴다(빈 섹션 금지).
export function RunTopology({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const t = useTranslations('runTopology')
  const [topology, setTopology] = useState<TopologyStatus | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [logs, setLogs] = useState<Record<string, string | undefined>>({})

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

  // 행 펼침 — 이벤트 피드는 로스터에 이미 실려 있고, 로그만 온디맨드 1회 fetch.
  const toggle = async (service: string) => {
    const next = !open[service]
    setOpen((prev) => ({ ...prev, [service]: next }))
    if (!next || logs[service] !== undefined) return
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/topology/${encodeURIComponent(service)}/logs`
      )
      if (!res.ok) return
      const body = (await res.json()) as { found: boolean; text: string }
      setLogs((prev) => ({ ...prev, [service]: body.found ? body.text : t('noLogs') }))
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
        {topology.services.map((svc) => {
          // 라이브 상세 요약 줄 — 값이 있는 항목만 · 구분자로 잇는다(빈 섹션 숨김 관례).
          const detail = [
            svc.image,
            svc.port !== undefined ? `:${svc.port}` : undefined,
            svc.node,
            svc.cpu !== undefined ? `cpu ${svc.cpu}` : undefined,
            svc.memoryMb !== undefined ? `${svc.memoryMb} MiB` : undefined,
            svc.ageSeconds !== undefined ? t('age', { age: fmtDurationMs(svc.ageSeconds * 1000) }) : undefined,
          ].filter(Boolean)
          return (
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
                <button
                  type="button"
                  onClick={() => void toggle(svc.name)}
                  className="font-mono text-[12.5px] font-medium hover:underline"
                >
                  {svc.name}
                </button>
                {svc.role && (
                  <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-faint">
                    {t(`role.${svc.role}`)}
                  </span>
                )}
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
                  onClick={() => void toggle(svc.name)}
                  className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10.5px] text-faint transition-colors hover:bg-muted hover:text-muted-foreground"
                >
                  {open[svc.name] ? t('hideDetail') : t('showDetail')}
                </button>
              </div>
              {detail.length > 0 && (
                <p
                  className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80"
                  title={detail.join(' · ')}
                >
                  {detail.join(' · ')}
                </p>
              )}
              {!open[svc.name] && svc.lastEvent && (
                <p
                  className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/60"
                  title={svc.lastEvent}
                >
                  {svc.lastEvent}
                </p>
              )}
              {open[svc.name] && (
                <div className="mt-2 space-y-2">
                  {svc.endpoint && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      <span className="text-faint">{t('endpoint')} </span>
                      {svc.endpoint}
                    </p>
                  )}
                  {svc.events.length > 0 && (
                    <div className="max-h-40 space-y-0.5 overflow-auto rounded-lg border border-border bg-muted/40 p-2.5">
                      {svc.events.map((e, i) => (
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
                  <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {logs[svc.name] ?? t('loadingLogs')}
                  </pre>
                </div>
              )}
            </div>
          )
        })}
      </Card>
    </div>
  )
}
