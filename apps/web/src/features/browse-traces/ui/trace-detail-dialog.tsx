'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Database,
  FileText,
  Hash,
  Play,
  X,
} from 'lucide-react'
import { useTimeZone, useTranslations } from 'next-intl'

import type {
  TraceInspectResult,
  TraceProvenance,
  TraceSpanNode,
  TraceSummary,
} from '@/entities/trace'
import { fmtDateTime, fmtDurationMs, fmtTokens, fmtUsd } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'

import { inspectTraceAction } from '../api/browse-traces'
import { AttributesView, IoPanel } from './data-view'
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

// The observability-grade trace detail — a near-fullscreen modal: waterfall on the left, the selected
// span's I/O + attributes in a side panel on the right (so a long timeline never buries the detail).
// When the platform gives no structured spans (native kinds), it falls back to the events timeline.
// `nav` pages through the sibling traces of the list this was opened from (prev/next, also ←/→ keys);
// `onSelect` turns the dialog into a picker — a "Use this trace" primary action (the judge wizard).
export function TraceDetailDialog({
  open,
  onClose,
  sourceName,
  trace,
  nav,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  sourceName: string
  trace: TraceSummary
  nav?: { index: number; total: number; onPrev: () => void; onNext: () => void }
  onSelect?: (trace: TraceSummary) => void
}) {
  const t = useTranslations('traceBrowser')
  const timeZone = useTimeZone()
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

  // ←/→ page through sibling traces while the dialog is open (mouse buttons stay the primary affordance).
  const hasPrev = nav !== undefined && nav.index > 0
  const hasNext = nav !== undefined && nav.index < nav.total - 1
  useEffect(() => {
    if (!open || !nav) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft' && hasPrev) nav?.onPrev()
      if (e.key === 'ArrowRight' && hasNext) nav?.onNext()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, nav, hasPrev, hasNext])

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
  // Everdict origin — on the list summary for most platforms; native kinds (langfuse) carry it only on inspect.
  const provenance = trace.provenance ?? result?.provenance

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="trace-detail-title"
      className="flex h-[90vh] max-h-[90vh] max-w-[1400px] flex-col"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0 space-y-1">
          <h2 id="trace-detail-title" className="flex items-center gap-2 text-[15px] font-[600]">
            <span className="truncate">{trace.name ?? t('unnamedTrace')}</span>
            <Badge tone={status === 'ok' ? 'success' : status === 'error' ? 'danger' : 'outline'}>
              {t(`status_${status}`)}
            </Badge>
          </h2>
          <div className="truncate font-mono text-[11px] text-faint">
            {trace.id}
            {trace.scope ? ` · ${trace.scope}` : ''}
          </div>
          {provenance && <OriginBar provenance={provenance} />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {nav && (
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={nav.onPrev}
                disabled={!hasPrev}
                aria-label={t('prevTrace')}
                className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35 disabled:hover:text-muted-foreground"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="min-w-12 text-center font-mono text-[11px] tabular-nums text-faint">
                {nav.index + 1} / {nav.total}
              </span>
              <button
                type="button"
                onClick={nav.onNext}
                disabled={!hasNext}
                aria-label={t('nextTrace')}
                className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35 disabled:hover:text-muted-foreground"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* Meta strip */}
      <div className="flex flex-wrap gap-x-7 gap-y-2 border-b border-border bg-card/50 px-5 py-3">
        <Meta label={t('colDuration')} value={fmtDurationMs(durationMs)} />
        <Meta label={t('metaSpanCount')} value={spanCount != null ? String(spanCount) : '–'} />
        <Meta
          label={t('colTokens')}
          value={tokens ? `${fmtTokens(tokens.input)}→${fmtTokens(tokens.output)}` : '–'}
        />
        <Meta label={t('colCost')} value={fmtUsd(costUsd)} />
        <Meta label={t('colModel')} value={model ?? '–'} />
        <Meta label={t('colStarted')} value={startedAt ? fmtDateTime(startedAt, timeZone) : '–'} />
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="p-5">
            <Callout tone="danger">{error}</Callout>
          </div>
        ) : pending && !result ? (
          <p className="p-5 text-[12px] text-faint">{t('loadingTrace')}</p>
        ) : spans.length > 0 ? (
          // Waterfall left, selected-span detail right — each pane scrolls on its own (≥lg);
          // below lg they stack and the whole body scrolls.
          <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
            <section className="min-w-0 flex-1 px-5 py-4 lg:overflow-y-auto">
              <SectionHead title={t('waterfall')}>
                <Legend />
              </SectionHead>
              <div className="mt-2 space-y-0.5">
                {spans.map((s) => {
                  const depth = depths.get(s.id) ?? 0
                  const leftPct = (s.startOffsetMs / total) * 100
                  const widthPct = Math.max(0.6, (s.durationMs / total) * 100)
                  const isSel = selected?.id === s.id
                  const hasTokens = s.tokens?.input != null || s.tokens?.output != null
                  // The row stays ONE line: tokens + cost sit in a fixed-width right rail (so every bar keeps a
                  // shared time axis), and the I/O preview rides the hover tooltip — full I/O is a click away in
                  // the side panel. This keeps tool-vs-model signal visible without fattening the row.
                  const ioTitle =
                    [
                      s.input ? `${t('input')}: ${compactPreview(s.input)}` : null,
                      s.output ? `${t('output')}: ${compactPreview(s.output)}` : null,
                    ]
                      .filter(Boolean)
                      .join('\n') || undefined
                  return (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => setSelectedId(s.id)}
                      title={ioTitle}
                      className={cn(
                        'grid w-full items-center gap-2 rounded-md py-1 text-left [grid-template-columns:minmax(110px,200px)_1fr_7rem] hover:bg-elevated/50',
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
                      {/* Right rail — tokens (models) + cost, right-aligned; fixed width keeps bars aligned. */}
                      <span className="flex items-center justify-end gap-1.5 overflow-hidden pr-1 font-mono text-[10px] tabular-nums text-faint">
                        {hasTokens && (
                          <span
                            className="flex items-center gap-0.5 whitespace-nowrap"
                            title={t('colTokens')}
                          >
                            <Hash className="size-2.5 opacity-70" />
                            {fmtTokens(s.tokens?.input)}→{fmtTokens(s.tokens?.output)}
                          </span>
                        )}
                        {s.costUsd != null && (
                          <span className="whitespace-nowrap text-faint/80">
                            {fmtUsd(s.costUsd)}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>

            {/* Selected span detail — the side panel */}
            <aside className="shrink-0 border-t border-border lg:w-[44%] lg:min-w-[400px] lg:max-w-[640px] lg:overflow-y-auto lg:border-l lg:border-t-0">
              {selected && (
                <div className="space-y-4 px-5 py-4">
                  <div>
                    <SectionHead
                      title={t('spanDetail')}
                      right={
                        <span className="font-mono text-[11px] text-faint">
                          +{fmtDurationMs(selected.startOffsetMs)} ·{' '}
                          {fmtDurationMs(selected.durationMs)}
                        </span>
                      }
                    />
                    <div className="mt-2 flex min-w-0 items-center gap-1.5">
                      <SpanTypeTag type={selected.type} />
                      <span className="truncate text-[13px] font-[600]">{selected.name}</span>
                    </div>
                    {(selected.model || selected.tokens || selected.costUsd != null) && (
                      <div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {metricLine(selected)}
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    {/* Key per span so the JSON-vs-raw default is recomputed for each span, not reused. */}
                    {selected.input !== undefined && (
                      <IoPanel key={`in-${selected.id}`} label={t('input')} text={selected.input} />
                    )}
                    {selected.output !== undefined && (
                      <IoPanel
                        key={`out-${selected.id}`}
                        label={t('output')}
                        accent
                        text={selected.output}
                      />
                    )}
                    {selected.input === undefined && selected.output === undefined && (
                      <p className="text-[12px] text-faint">{t('noIo')}</p>
                    )}
                  </div>
                  <AttributesView attributes={selected.attributes} />
                </div>
              )}
            </aside>
          </div>
        ) : (
          // Native-kind fallback — no structured spans; show the normalized events timeline + raw attributes.
          <div className="h-full overflow-y-auto p-4">
            <TraceDetail sourceName={sourceName} traceId={trace.id} />
          </div>
        )}
      </div>

      {/* Picker footer — only when the dialog is a selector (judge wizard). */}
      {onSelect && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
          <Button onClick={() => onSelect(trace)} className="gap-1.5">
            <Check className="size-4" />
            {t('useThisTrace')}
          </Button>
        </div>
      )}
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

// One-line, whitespace-collapsed preview of a payload for the waterfall row (the full value lives in the
// side panel). Capped so a huge payload never bloats the row DOM — the truncate class elides the rest.
function compactPreview(v: string): string {
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

function metricLine(s: TraceSpanNode): string {
  const parts: string[] = []
  if (s.model) parts.push(s.model)
  if (s.tokens) parts.push(`${fmtTokens(s.tokens.input)}→${fmtTokens(s.tokens.output)}`)
  if (s.costUsd != null) parts.push(fmtUsd(s.costUsd))
  return parts.join(' · ') || '–'
}

// Everdict origin chips — deep-link a pulled trace back to the run/scorecard/dataset/harness that produced it, so a
// human (and, via the same `provenance` data on the API/MCP, an agent) can pull the related context before acting.
// dataset/harness arrive as "id@version": link to the base id, show the full ref.
function OriginChip({
  label,
  value,
  href,
  icon: Icon,
}: {
  label: string
  value: string
  href?: string
  icon: typeof Play
}) {
  const inner = (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[10.5px]',
        href && 'transition-colors hover:border-border-strong hover:bg-elevated'
      )}
    >
      <Icon className="size-3 shrink-0 text-faint" />
      <span className="shrink-0 text-faint">{label}</span>
      <span className="max-w-[180px] truncate font-mono text-foreground/80">{value}</span>
    </span>
  )
  return href ? (
    <Link href={href} className="min-w-0">
      {inner}
    </Link>
  ) : (
    inner
  )
}

function OriginBar({ provenance }: { provenance: TraceProvenance }) {
  const t = useTranslations('traceBrowser')
  const params = useParams<{ workspace: string }>()
  const ws = typeof params.workspace === 'string' ? params.workspace : undefined
  const baseId = (ref: string) => ref.split('@')[0] ?? ref
  const link = (path: string, id: string) =>
    ws ? `/${ws}/${path}/${encodeURIComponent(id)}` : undefined

  const chips: { key: string; label: string; value: string; href?: string; icon: typeof Play }[] =
    []
  if (provenance.scorecardId)
    chips.push({
      key: 'sc',
      label: t('originScorecard'),
      value: provenance.scorecardId,
      href: link('scorecards', provenance.scorecardId),
      icon: ClipboardCheck,
    })
  if (provenance.runId)
    chips.push({
      key: 'run',
      label: t('originRun'),
      value: provenance.runId,
      href: link('runs', provenance.runId),
      icon: Play,
    })
  if (provenance.dataset)
    chips.push({
      key: 'ds',
      label: t('originDataset'),
      value: provenance.dataset,
      href: link('datasets', baseId(provenance.dataset)),
      icon: Database,
    })
  if (provenance.harness)
    chips.push({
      key: 'hn',
      label: t('originHarness'),
      value: provenance.harness,
      href: link('harnesses', baseId(provenance.harness)),
      icon: Boxes,
    })
  if (provenance.caseId)
    chips.push({ key: 'case', label: t('originCase'), value: provenance.caseId, icon: FileText })
  if (chips.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="text-[10px] uppercase tracking-wide text-faint">{t('origin')}</span>
      {chips.map((c) => (
        <OriginChip key={c.key} label={c.label} value={c.value} href={c.href} icon={c.icon} />
      ))}
    </div>
  )
}
