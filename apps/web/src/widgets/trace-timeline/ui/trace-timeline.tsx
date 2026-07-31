'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import { summarizeTraceEvent, traceKindColor, type TraceEvent } from '@/entities/run'
import { cn } from '@/shared/lib/utils'

// 궤적의 플레인 축 — 에이전트(하니스 이벤트) · 배치(infra scope placement) · 서비스(infra scope service).
// 인프라 플레인이 궤적에 실리면서(kind "infra") 평평한 목록으로는 섞여 읽히지 않아, 플레인 칩으로 거른다.
// 칩은 이벤트가 있는 플레인만 노출(빈 섹션 숨김 관례); 전부 한 플레인이면 칩 자체를 숨긴다.
type Plane = 'all' | 'agent' | 'placement' | 'service'

function planeOf(e: TraceEvent): Exclude<Plane, 'all'> {
  if (e.kind !== 'infra') return 'agent'
  const scope = (e as Record<string, unknown>).scope
  return scope === 'service' ? 'service' : 'placement'
}

export function TraceTimeline({ trace }: { trace: TraceEvent[] }) {
  const t = useTranslations('traceTimeline')
  const [plane, setPlane] = useState<Plane>('all')
  const counts = useMemo(() => {
    const c: Record<Exclude<Plane, 'all'>, number> = { agent: 0, placement: 0, service: 0 }
    for (const e of trace) c[planeOf(e)]++
    return c
  }, [trace])
  if (trace.length === 0) {
    return <p className="text-[13px] text-muted-foreground">{t('empty')}</p>
  }
  const planes = (['agent', 'placement', 'service'] as const).filter((p) => counts[p] > 0)
  const filtered = plane === 'all' ? trace : trace.filter((e) => planeOf(e) === plane)
  return (
    <div className="space-y-3">
      {planes.length > 1 && (
        <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5 w-fit">
          {(['all', ...planes] as Plane[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPlane(p)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] transition-colors',
                p === plane ? 'bg-muted text-foreground' : 'text-faint hover:text-muted-foreground'
              )}
            >
              {t(`plane.${p}`)}
              {p !== 'all' && (
                <span className="ml-1 font-mono text-[10px] text-faint">
                  {counts[p as Exclude<Plane, 'all'>]}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <ol className="relative space-y-3.5 border-l border-border/70 pl-6">
        {filtered.map((e, i) => (
          <li key={i} className="relative">
            <span
              className={cn(
                'absolute -left-[1.625rem] top-1 size-2.5 rounded-full ring-4 ring-card',
                traceKindColor(e.kind)
              )}
            />
            <div className="flex items-center gap-2">
              <code className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-[510]">
                {e.kind}
              </code>
              <span className="font-mono text-[11px] text-faint">t={e.t}</span>
            </div>
            <p className="mt-1 break-all text-[12px] leading-relaxed text-muted-foreground">
              {summarizeTraceEvent(e)}
            </p>
          </li>
        ))}
      </ol>
    </div>
  )
}
