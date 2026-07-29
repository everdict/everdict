'use client'

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

import { cn } from '@/shared/lib/utils'

import type { ChartSeries } from './palette'

// The chrome every plot in the app shares: geometry constants, the measured width, a clean tick scale,
// the recessive grid, the axis band, the legend and the tooltip shell. Charts own their marks and nothing
// else, so a new chart cannot invent its own axis weight, tick rounding or label color.

export const CHART = {
  marginLeft: 48,
  marginRight: 8,
  marginTop: 8,
  marginBottom: 22,
  plotHeight: 200,
  /** Surface gap separating touching marks — stacked segments and adjacent bars alike. */
  segmentGap: 2,
  /** Bars never fill their slot; the leftover band is air. */
  maxBarWidth: 24,
} as const

/** Total SVG height — the x-axis band is INSIDE it, so a fixed container never clips the labels. */
export const CHART_HEIGHT = CHART.marginTop + CHART.plotHeight + CHART.marginBottom

/** Track the rendered width so the plot is responsive without a viewBox lying about its own scale. */
export function useMeasuredWidth(fallback = 640): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

// 1/2/5×10^k step, so ticks land on numbers a reader recognises instead of 0.3333.
function niceStep(rough: number): number {
  if (!(rough > 0)) return 1
  const pow = 10 ** Math.floor(Math.log10(rough))
  const f = rough / pow
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow
}

export interface Scale {
  bottom: number
  top: number
  ticks: number[]
}

/**
 * A tick scale over the data range. The baseline is pinned to zero (a bar's length must mean its value),
 * and a negative range extends the domain below it rather than floating the baseline. `fixed` pins the
 * domain outright — pass `{min: 0, max: 1}` for a ratio so 0–100% is always the frame of reference.
 */
export function niceScale(
  dataMin: number,
  dataMax: number,
  options: { targetTicks?: number; fixed?: { min: number; max: number } } = {}
): Scale {
  const { targetTicks = 3, fixed } = options
  if (fixed) {
    const step = niceStep((fixed.max - fixed.min) / targetTicks)
    return { bottom: fixed.min, top: fixed.max, ticks: buildTicks(fixed.min, fixed.max, step) }
  }
  const lo = Math.min(0, dataMin)
  const hi = Math.max(0, dataMax)
  if (hi === lo) return { bottom: 0, top: 1, ticks: [0, 1] }
  const step = niceStep((hi - lo) / targetTicks)
  const bottom = Math.floor(lo / step + 1e-9) * step
  const top = Math.ceil(hi / step - 1e-9) * step
  return { bottom, top, ticks: buildTicks(bottom, top, step) }
}

function buildTicks(bottom: number, top: number, step: number): number[] {
  const ticks: number[] = []
  for (let v = bottom; v <= top + step * 1e-9; v += step) {
    // Re-round each step: accumulating a float step drifts into 0.30000000000000004 by the third tick.
    ticks.push(Number(v.toPrecision(12)))
  }
  return ticks
}

/** Recessive y grid — solid hairlines one step off the surface, values in muted ink (never a series color). */
export function GridLines({
  scale,
  yOf,
  left,
  width,
  format,
}: {
  scale: Scale
  yOf: (v: number) => number
  left: number
  width: number
  format: (v: number) => string
}) {
  return (
    <>
      {scale.ticks.map((v) => (
        <g key={v}>
          <line
            x1={left}
            x2={left + width}
            y1={yOf(v)}
            y2={yOf(v)}
            stroke={v === 0 ? 'var(--color-border-strong)' : 'var(--color-border)'}
            strokeWidth={1}
          />
          <text
            x={left - 6}
            y={yOf(v) + 3}
            textAnchor="end"
            className="fill-[var(--color-faint)] text-[10px] tabular-nums"
          >
            {format(v)}
          </text>
        </g>
      ))}
    </>
  )
}

/**
 * X labels, thinned to whatever the width can hold. Labels are dropped wholesale rather than rotated or
 * truncated per-tick, so the ones that survive stay horizontal and readable.
 */
export function XAxisLabels({
  labels,
  xOf,
  plotWidth,
  format = (l) => l,
}: {
  labels: string[]
  xOf: (index: number) => number
  plotWidth: number
  format?: (label: string, index: number) => string
}) {
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(plotWidth / 72))))
  return (
    <>
      {labels.map((label, i) =>
        i % every === 0 ? (
          <text
            key={`${label}-${i}`}
            x={xOf(i)}
            y={CHART_HEIGHT - 6}
            textAnchor="middle"
            className="fill-[var(--color-faint)] text-[10px] tabular-nums"
          >
            {format(label, i)}
          </text>
        ) : null
      )}
    </>
  )
}

/**
 * Identity is never color-alone: two or more series always get a legend. A single series gets none — the
 * card title already names what is plotted, so a one-swatch box would just restate it.
 */
export function ChartLegend({ series }: { series: ChartSeries[] }) {
  if (series.length < 2) return null
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5 text-muted-foreground">
          <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  )
}

/** Hover/focus readout. It enhances — every value it shows is also in the axis ticks or the raw table. */
export function ChartTooltip({ left, children }: { left: number; children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute top-2 z-10 w-[190px] -translate-x-1/2 rounded-md border bg-popover p-2 text-[12px] shadow-[var(--pop-shadow)]"
      style={{ left }}
    >
      {children}
    </div>
  )
}

/** One `label — value` line of a tooltip, with the series swatch carrying identity beside the ink text. */
export function TooltipRow({
  color,
  label,
  value,
  dimmed,
}: {
  color: string
  label: string
  value: string
  dimmed?: boolean
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2', dimmed && 'opacity-55')}>
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <span className="h-[3px] w-2.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate">{label}</span>
      </span>
      <span className="shrink-0 tabular-nums text-foreground">{value}</span>
    </div>
  )
}

/** Keep the tooltip inside the card: centred on the mark, clamped to the plot edges. */
export function clampTooltip(center: number, width: number): number {
  return Math.min(Math.max(center, 96), Math.max(96, width - 100))
}

export function ChartEmpty({ label }: { label: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">
      {label}
    </div>
  )
}
