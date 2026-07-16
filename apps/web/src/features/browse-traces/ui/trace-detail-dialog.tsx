'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { TraceInspectResult, TraceSpanNode, TraceSummary } from '@/entities/trace'
import { fmtDateTime, fmtDurationMs, fmtTokens, fmtUsd } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'

import { inspectTraceAction } from '../api/browse-traces'
import { TraceDetail } from './trace-detail'

// Span-type accent (fixed hexes — like the existing EventRow kind colors — so they read on both themes).
const SPAN_COLOR: Record<TraceSpanNode['type'], string> = {
  agent: '#5e6ad2',
  llm: '#9d7be6',
  tool: '#3fb6b2',
  retriever: '#e0a04c',
  chain: '#8a8f98',
  span: '#8a8f98',
}

// depth of each span by walking parentId (missing/cyclic parent → treat as a root, capped).
function computeDepths(spans: TraceSpanNode[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.id, s]))
  const depth = new Map<string, number>()
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    const node = byId.get(id)
    const parentId = node?.parentId
    const d =
      parentId && parentId !== id && byId.has(parentId) && !seen.has(parentId)
        ? resolve(parentId, new Set(seen).add(id)) + 1
        : 0
    depth.set(id, Math.min(d, 8))
    return depth.get(id) ?? 0
  }
  for (const s of spans) resolve(s.id, new Set())
  return depth
}

// The observability-grade trace detail — a modal with the meta strip, a span waterfall, and the selected span's
// I/O + attributes. When the platform gives no structured spans (native kinds), it falls back to the events timeline.
export function TraceDetailDialog({
  open,
  onClose,
  sourceName,
  trace,
}: {
  open: boolean
  onClose: () => void
  sourceName: string
  trace: TraceSummary
}) {
  const t = useTranslations('traceBrowser')
  const [result, setResult] = useState<TraceInspectResult | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [pending, start] = useTransition()

  useEffect(() => {
    if (!open) return
    setResult(undefined)
    setError(undefined)
    setSelectedId(undefined)
    start(async () => {
      const res = await inspectTraceAction(sourceName, trace.id)
      if (res.ok) setResult(res.result)
      else setError(res.error)
    })
  }, [open, sourceName, trace.id])

  const spans = result?.detail?.spans ?? []
  const rollup = result?.detail?.rollup
  const depths = useMemo(() => computeDepths(spans), [spans])
  const total = useMemo(
    () => Math.max(1, ...spans.map((s) => s.startOffsetMs + s.durationMs)),
    [spans]
  )
  const selected = spans.find((s) => s.id === selectedId) ?? spans[0]

  // Meta strip values — prefer the inspect rollup, fall back to the list summary.
  const durationMs = rollup?.durationMs ?? trace.durationMs
  const spanCount = rollup?.spanCount ?? (spans.length || undefined)
  const tokens = rollup?.tokens ?? trace.tokens
  const costUsd = rollup?.costUsd ?? trace.costUsd
  const model = rollup?.llmModel ?? trace.llmModel
  const startedAt = rollup?.startedAt ?? trace.startedAt
  const status = rollup?.status ?? trace.status ?? 'unset'

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="trace-detail-title"
      className="max-w-4xl max-h-[90vh] flex flex-col"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0 space-y-1">
          <h2 id="trace-detail-title" className="flex items-center gap-2 text-[15px] font-[600]">
            <span className="truncate">{trace.name ?? t('unnamedTrace')}</span>
            <Badge
              tone={status === 'ok' ? 'success' : status === 'error' ? 'danger' : 'outline'}
            >
              {t(`status_${status}`)}
            </Badge>
          </h2>
          <div className="truncate font-mono text-[11px] text-faint">
            {trace.id}
            {trace.scope ? ` · ${trace.scope}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Meta strip */}
      <div className="flex flex-wrap gap-x-7 gap-y-2 border-b border-border bg-card/50 px-5 py-3">
        <Meta label={t('colDuration')} value={fmtDurationMs(durationMs)} />
        <Meta label={t('metaSpanCount')} value={spanCount != null ? String(spanCount) : '–'} />
        <Meta label={t('colTokens')} value={tokens ? `${fmtTokens(tokens.input)}→${fmtTokens(tokens.output)}` : '–'} />
        <Meta label={t('colCost')} value={fmtUsd(costUsd)} />
        <Meta label={t('colModel')} value={model ?? '–'} />
        <Meta label={t('colStarted')} value={startedAt ? fmtDateTime(startedAt) : '–'} />
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="p-5">
            <Callout tone="danger">{error}</Callout>
          </div>
        ) : pending && !result ? (
          <p className="p-5 text-[12px] text-faint">{t('loadingTrace')}</p>
        ) : spans.length > 0 ? (
          <>
            {/* Waterfall */}
            <section className="border-b border-border px-5 py-4">
              <SectionHead title={t('waterfall')}>
                <Legend />
              </SectionHead>
              <div className="mt-2 space-y-0.5">
                {spans.map((s) => {
                  const depth = depths.get(s.id) ?? 0
                  const leftPct = (s.startOffsetMs / total) * 100
                  const widthPct = Math.max(0.6, (s.durationMs / total) * 100)
                  const isSel = selected?.id === s.id
                  return (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => setSelectedId(s.id)}
                      className={cn(
                        'grid w-full items-center gap-2 rounded-md py-1 text-left [grid-template-columns:minmax(120px,220px)_1fr] hover:bg-elevated/50',
                        isSel && 'bg-primary/10'
                      )}
                    >
                      <span
                        className="flex min-w-0 items-center gap-1.5 text-[12px]"
                        style={{ paddingLeft: depth * 14 }}
                      >
                        <SpanTypeTag type={s.type} />
                        <span className="truncate text-foreground/90">{s.name}</span>
                      </span>
                      <span className="relative h-4 border-l border-border">
                        <span
                          className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm"
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            backgroundColor: SPAN_COLOR[s.type],
                            minWidth: 3,
                          }}
                        />
                        <span
                          className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[9.5px] tabular-nums text-faint"
                          style={{ left: `calc(min(${leftPct + widthPct}%, 88%) + 6px)` }}
                        >
                          {fmtDurationMs(s.durationMs)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>

            {/* Selected span detail */}
            {selected && (
              <section className="px-5 py-4">
                <SectionHead
                  title={`${t('spanDetail')} · ${selected.name}`}
                  right={
                    <span className="font-mono text-[11px] text-faint">
                      +{fmtDurationMs(selected.startOffsetMs)} · {fmtDurationMs(selected.durationMs)}
                    </span>
                  }
                />
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <FieldLabel>{t('io')}</FieldLabel>
                    {selected.input !== undefined && <IoBlock role={t('input')} text={selected.input} />}
                    {selected.output !== undefined && <IoBlock role={t('output')} accent text={selected.output} />}
                    {selected.input === undefined && selected.output === undefined && (
                      <p className="text-[12px] text-faint">{t('noIo')}</p>
                    )}
                  </div>
                  <div className="space-y-3">
                    <div>
                      <FieldLabel>{t('attributes')}</FieldLabel>
                      <div className="mt-1 divide-y divide-border/60 rounded-md border border-border">
                        {(selected.model || selected.tokens || selected.costUsd != null) && (
                          <KvRow k={t('colModel')} v={metricLine(selected)} />
                        )}
                        {Object.entries(selected.attributes)
                          .slice(0, 24)
                          .map(([k, v]) => (
                            <KvRow key={k} k={k} v={valueStr(v)} />
                          ))}
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            )}
          </>
        ) : (
          // Native-kind fallback — no structured spans; show the normalized events timeline + raw attributes.
          <div className="p-4">
            <TraceDetail sourceName={sourceName} traceId={trace.id} />
          </div>
        )}
      </div>
    </Dialog>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-faint">{label}</span>
      <span className="text-[13px] font-[560] tabular-nums">{value}</span>
    </div>
  )
}

function SectionHead({
  title,
  right,
  children,
}: {
  title: string
  right?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] font-[510] uppercase tracking-wide text-faint">{title}</span>
      {right}
      {children}
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10.5px] uppercase tracking-wide text-faint">{children}</div>
}

function SpanTypeTag({ type }: { type: TraceSpanNode['type'] }) {
  return (
    <span
      className="rounded-[3px] px-1 text-[9px] font-[700] uppercase tracking-wide"
      style={{ backgroundColor: `${SPAN_COLOR[type]}28`, color: SPAN_COLOR[type] }}
    >
      {type}
    </span>
  )
}

function Legend() {
  return (
    <span className="flex gap-3">
      {(['agent', 'llm', 'tool'] as const).map((k) => (
        <span key={k} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="size-2 rounded-[2px]" style={{ backgroundColor: SPAN_COLOR[k] }} />
          {k}
        </span>
      ))}
    </span>
  )
}

function IoBlock({ role, text, accent }: { role: string; text: string; accent?: boolean }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div
        className={cn(
          'border-b border-border bg-card px-2.5 py-1 text-[10px] uppercase tracking-wide',
          accent ? 'text-[#c5aef0]' : 'text-faint'
        )}
      >
        {role}
      </div>
      <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-foreground/85">
        {text.slice(0, 4000)}
      </div>
    </div>
  )
}

function KvRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 px-2.5 py-1.5 text-[12px]">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="truncate text-right font-mono text-[11px] tabular-nums text-foreground/80">{v}</span>
    </div>
  )
}

function metricLine(s: TraceSpanNode): string {
  const parts: string[] = []
  if (s.model) parts.push(s.model)
  if (s.tokens) parts.push(`${fmtTokens(s.tokens.input)}→${fmtTokens(s.tokens.output)}`)
  if (s.costUsd != null) parts.push(fmtUsd(s.costUsd))
  return parts.join(' · ') || '–'
}

function valueStr(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 120)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v).slice(0, 120)
  } catch {
    return String(v)
  }
}
