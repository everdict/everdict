'use client'

import { useEffect, useState, useTransition } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { SpanAttrMapping, TraceEvent, TraceInspectResult } from '@/entities/trace'
import { fmtDurationMs, fmtTokens, fmtUsd } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { ModelChip } from '@/shared/ui/chip'

import { inspectTraceAction } from '../api/browse-traces'

// One normalized event row — kind-aware rendering of the timeline the judge sees.
function EventRow({ event, index }: { event: TraceEvent; index: number }) {
  const t = useTranslations('traceBrowser')
  const kindTone: Record<TraceEvent['kind'], string> = {
    message: 'text-foreground',
    llm_call: 'text-[#fc9a6e]',
    tool_call: 'text-primary',
    tool_result: 'text-muted-foreground',
    env_action: 'text-muted-foreground',
    error: 'text-destructive',
    log: 'text-faint',
    artifact: 'text-[var(--color-success)]',
    span: 'text-faint',
  }
  return (
    <li className="flex gap-3 px-3 py-1.5">
      <span className="w-10 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums text-faint">
        {index}
      </span>
      <span
        className={cn(
          'w-20 shrink-0 pt-0.5 font-mono text-[10px] uppercase tracking-wide',
          kindTone[event.kind]
        )}
      >
        {event.kind}
      </span>
      <div className="min-w-0 flex-1 text-[12px] leading-relaxed">
        {event.kind === 'message' && (
          <div>
            <span className="mr-1.5 text-faint">{event.role}:</span>
            <span className="whitespace-pre-wrap break-words text-foreground/90">{event.text}</span>
          </div>
        )}
        {event.kind === 'llm_call' && (
          <div className="flex flex-wrap items-center gap-2">
            <ModelChip muted>{event.model || t('unknownModel')}</ModelChip>
            {event.cost && (
              <span className="font-mono text-[11px] tabular-nums text-faint">
                {fmtTokens(event.cost.inputTokens)}→{fmtTokens(event.cost.outputTokens)} ·{' '}
                {fmtUsd(event.cost.usd)}
              </span>
            )}
            {event.latencyMs != null && (
              <span className="font-mono text-[11px] tabular-nums text-faint">
                {fmtDurationMs(event.latencyMs)}
              </span>
            )}
          </div>
        )}
        {event.kind === 'tool_call' && (
          <div className="min-w-0">
            <span className="font-mono text-primary">→ {event.name}</span>
            {event.args !== undefined && (
              <code className="ml-2 break-words text-[11px] text-faint">
                {JSON.stringify(event.args).slice(0, 200)}
              </code>
            )}
          </div>
        )}
        {event.kind === 'tool_result' && (
          <div className="min-w-0">
            <span className={event.ok ? 'text-[var(--color-success)]' : 'text-destructive'}>
              ← {event.ok ? t('ok') : t('failed')}
            </span>
            {event.output && (
              <span className="ml-2 break-words text-faint">{event.output.slice(0, 200)}</span>
            )}
          </div>
        )}
        {event.kind === 'env_action' && <span className="text-foreground/90">{event.action}</span>}
        {event.kind === 'error' && (
          <span className="whitespace-pre-wrap break-words text-destructive">{event.message}</span>
        )}
        {event.kind === 'log' && (
          <span className="whitespace-pre-wrap break-words font-mono text-[11px] text-faint">
            {event.text}
          </span>
        )}
        {event.kind === 'artifact' && (
          <span className="text-foreground/90">
            {event.name} <span className="text-faint">· {event.ref}</span>
          </span>
        )}
        {event.kind === 'span' && <span className="text-faint">{event.name}</span>}
      </div>
    </li>
  )
}

// Read-only trace detail — the normalized events timeline + (span-based kinds) the raw span attributes.
// Reused by the settings browser (drill-in). The wizard authors a mapping via a separate editor over the same inspect.
export function TraceDetail({
  sourceName,
  traceId,
  mapping,
}: {
  sourceName: string
  traceId: string
  mapping?: SpanAttrMapping
}) {
  const t = useTranslations('traceBrowser')
  const [result, setResult] = useState<TraceInspectResult | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [rawOpen, setRawOpen] = useState(false)
  const [pending, start] = useTransition()

  useEffect(() => {
    start(async () => {
      setError(undefined)
      const res = await inspectTraceAction(sourceName, traceId, mapping)
      if (res.ok) setResult(res.result)
      else setError(res.error)
    })
  }, [sourceName, traceId, mapping])

  if (error) return <Callout tone="danger">{error}</Callout>
  if (pending && !result)
    return <p className="px-3 py-4 text-[12px] text-faint">{t('loadingTrace')}</p>
  if (!result) return null

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 px-3 text-[11px] font-[510] uppercase tracking-wide text-faint">
          {t('timeline', { count: result.events.length })}
        </div>
        {result.events.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-faint">{t('noEvents')}</p>
        ) : (
          <ul className="divide-y divide-border/50 rounded-md border bg-card/50">
            {result.events.map((e, i) => (
              <EventRow key={`${e.kind}-${i}`} event={e} index={i} />
            ))}
          </ul>
        )}
      </div>
      {result.rawAttributes && result.rawAttributes.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setRawOpen((o) => !o)}
            className="flex items-center gap-1 px-3 text-[11px] font-[510] uppercase tracking-wide text-faint hover:text-foreground"
          >
            {rawOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t('rawSpans', { count: result.rawAttributes.length })}
          </button>
          {rawOpen && (
            <ul className="mt-1 space-y-1.5 rounded-md border bg-card/50 p-3">
              {result.rawAttributes.map((span, i) => (
                <li key={`${span.spanName}-${i}`} className="text-[11px]">
                  <div className="font-mono text-foreground/80">{span.spanName}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {Object.entries(span.attrs).map(([k, v]) => (
                      <Badge key={k} tone="outline" className="font-mono text-[10px]">
                        {k}={String(v).slice(0, 40)}
                      </Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
