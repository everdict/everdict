'use client'

import { useMemo } from 'react'
import { Hash } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { TraceSpanNode } from '@/entities/trace'
import { fmtDurationMs, fmtTokens, fmtUsd } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

// THE trace waterfall — one component, both sources. An external platform's trace (its own span tree, pulled
// through inspect) and our owned trajectory (normalized events that now carry the same structure) render
// through this, so "the internal trace viewer looks like a different product" stops being true by
// construction rather than by two files being kept in sync.
//
// A row is: [type tag + name, indented by depth] [bar on the shared time axis] [tokens · cost].
// Nesting comes from parentId; a missing or cyclic parent reads as a root, so a partial tree still draws.

// Span-type accent (fixed hexes so they read on both themes).
export const SPAN_COLOR: Record<TraceSpanNode['type'], string> = {
  agent: '#5e6ad2',
  llm: '#9d7be6',
  tool: '#3fb6b2',
  retriever: '#e0a04c',
  chain: '#8a8f98',
  span: '#8a8f98',
}

// Depth of each span by walking parentId (missing/cyclic parent → treat as a root, capped).
export function computeDepths(spans: TraceSpanNode[]): Map<string, number> {
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

export function SpanTypeTag({ type }: { type: TraceSpanNode['type'] }) {
  return (
    <span
      className="rounded-[3px] px-1 text-[9px] font-[700] uppercase tracking-wide"
      style={{ backgroundColor: `${SPAN_COLOR[type]}28`, color: SPAN_COLOR[type] }}
    >
      {type}
    </span>
  )
}

export function SpanLegend() {
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
export function compactPreview(v: string): string {
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

export function spanMetricLine(s: TraceSpanNode): string {
  const parts: string[] = []
  if (s.model) parts.push(s.model)
  if (s.tokens) parts.push(`${fmtTokens(s.tokens.input)}→${fmtTokens(s.tokens.output)}`)
  if (s.costUsd != null) parts.push(fmtUsd(s.costUsd))
  return parts.join(' · ') || '–'
}

export function SpanWaterfall({
  spans,
  selectedId,
  onSelect,
  // A trailing chip per row — the owned trajectory names the PLANE an event came from (agent · placement ·
  // a service). A single-process platform trace has none, and then no chip renders.
  laneLabelOf,
}: {
  spans: TraceSpanNode[]
  selectedId?: string
  onSelect: (id: string) => void
  laneLabelOf?: (id: string) => string | undefined
}) {
  const t = useTranslations('traceBrowser')
  const depths = useMemo(() => computeDepths(spans), [spans])
  const total = useMemo(
    () => Math.max(1, ...spans.map((s) => s.startOffsetMs + s.durationMs)),
    [spans]
  )

  return (
    <div className="space-y-0.5">
      {spans.map((s) => {
        const depth = depths.get(s.id) ?? 0
        const leftPct = (s.startOffsetMs / total) * 100
        const widthPct = Math.max(0.6, (s.durationMs / total) * 100)
        const isSel = selectedId === s.id
        const hasTokens = s.tokens?.input != null || s.tokens?.output != null
        const lane = laneLabelOf?.(s.id)
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
            onClick={() => onSelect(s.id)}
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
                  left: `${Math.min(leftPct, 99.4)}%`,
                  width: `${widthPct}%`,
                  backgroundColor: SPAN_COLOR[s.type],
                  minWidth: 3,
                }}
              />
              <span
                className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[9.5px] tabular-nums text-faint"
                style={{ left: `calc(min(${leftPct + widthPct}%, 88%) + 6px)` }}
              >
                {s.durationMs > 0 ? fmtDurationMs(s.durationMs) : ''}
              </span>
            </span>
            {/* Right rail — tokens (models) + cost or the plane chip, right-aligned; fixed width keeps bars aligned. */}
            <span className="flex items-center justify-end gap-1.5 overflow-hidden pr-1 font-mono text-[10px] tabular-nums text-faint">
              {hasTokens && (
                <span className="flex items-center gap-0.5 whitespace-nowrap" title={t('colTokens')}>
                  <Hash className="size-2.5 opacity-70" />
                  {fmtTokens(s.tokens?.input)}→{fmtTokens(s.tokens?.output)}
                </span>
              )}
              {s.costUsd != null && (
                <span className="whitespace-nowrap text-faint/80">{fmtUsd(s.costUsd)}</span>
              )}
              {lane && !hasTokens && (
                <span className="truncate rounded-[3px] bg-elevated px-1 text-[9.5px]">{lane}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
