'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { fmtUsd } from '@/shared/lib/format'

// One plotted series of the stacked daily-spend chart. Colors are FIXED per entity (a source always keeps its slot;
// a model keeps the slot its all-time rank assigned), never re-dealt when the range filter changes.
export interface ChartSeries {
  key: string
  label: string
  color: string
}

const MARGIN = { l: 48, r: 8, t: 8, b: 22 }
const PLOT_H = 200
const SEG_GAP = 2 // surface gap between stacked segments / adjacent bars (the separator is the card, not a stroke)
const MAX_BAR_W = 24

// 1/2/5×10^k step so the y ticks land on clean dollar amounts.
function niceStep(rough: number): number {
  const pow = 10 ** Math.floor(Math.log10(rough))
  const f = rough / pow
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10
  return nice * pow
}

// Topmost stacked segment: 4px-rounded data end, square at the join below (and at the baseline).
function cappedBarPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h)
  return `M ${x} ${y + h} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h} Z`
}

// Daily metered spend as a stacked column chart — hand-rolled SVG (repo idiom; no chart lib). The mark is the hit
// target: each day column carries a pointer/focus tooltip listing every series at that day; values also live in the
// breakdown table below the chart, so the tooltip enhances and never gates.
export function UsageChart({
  days,
  series,
  values, // values[seriesIndex][dayIndex] — usd
}: {
  days: string[]
  series: ChartSeries[]
  values: number[][]
}) {
  const t = useTranslations('manageBudget')
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hovered, setHovered] = useState<number>()

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const dayTotals = useMemo(
    () => days.map((_, i) => series.reduce((sum, _s, k) => sum + (values[k]?.[i] ?? 0), 0)),
    [days, series, values]
  )
  const maxTotal = Math.max(0, ...dayTotals)

  const H = MARGIN.t + PLOT_H + MARGIN.b
  const plotW = Math.max(40, width - MARGIN.l - MARGIN.r)
  const n = days.length
  const slot = plotW / Math.max(1, n)
  const barW = Math.min(MAX_BAR_W, Math.max(2, slot - SEG_GAP))
  const baseline = MARGIN.t + PLOT_H

  // Clean y scale: 3–4 ticks on 1/2/5 steps, top tick >= the tallest day.
  const step = maxTotal > 0 ? niceStep(maxTotal / 3) : 1
  const top = maxTotal > 0 ? Math.ceil(maxTotal / step - 1e-9) * step : 1
  const yTicks = useMemo(() => {
    const ticks: number[] = []
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v)
    return ticks
  }, [top, step])
  const yOf = (v: number) => baseline - (v / top) * PLOT_H

  const xOf = (i: number) => MARGIN.l + i * slot + (slot - barW) / 2
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 72))))

  if (maxTotal <= 0) {
    return (
      <div ref={wrapRef} className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">
        {t('chartEmpty')}
      </div>
    )
  }

  const hoveredDay = hovered !== undefined ? days[hovered] : undefined
  // Keep the tooltip inside the card: center it on the column, clamped to the plot edges.
  const tooltipLeft =
    hovered !== undefined ? Math.min(Math.max(xOf(hovered) + barW / 2, 90), Math.max(90, width - 110)) : 0

  return (
    <div ref={wrapRef} className="relative">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={t('dailyTitle')}
        className="block"
        onPointerLeave={() => setHovered(undefined)}
      >
        {/* recessive grid: solid hairlines one step off the surface; labels in muted ink, never the series color */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={MARGIN.l}
              x2={MARGIN.l + plotW}
              y1={yOf(v)}
              y2={yOf(v)}
              stroke={v === 0 ? 'var(--color-border-strong)' : 'var(--color-border)'}
              strokeWidth={1}
            />
            <text
              x={MARGIN.l - 6}
              y={yOf(v) + 3}
              textAnchor="end"
              className="fill-[var(--color-faint)] text-[10px] tabular-nums"
            >
              {fmtUsd(v)}
            </text>
          </g>
        ))}

        {days.map((day, i) => {
          const totalOfDay = dayTotals[i] ?? 0
          const x = xOf(i)
          let cum = 0
          const nonZero = series
            .map((s, k) => ({ s, k, v: values[k]?.[i] ?? 0 }))
            .filter((e) => e.v > 0)
          return (
            <g key={day}>
              {hovered === i && (
                <rect
                  x={MARGIN.l + i * slot}
                  y={MARGIN.t}
                  width={slot}
                  height={PLOT_H}
                  fill="var(--color-muted)"
                />
              )}
              {nonZero.map(({ s, k, v }, idx) => {
                const isTop = idx === nonZero.length - 1
                const bottomY = yOf(cum)
                cum += v
                const topY = yOf(cum)
                // A 2px surface gap separates a segment from the one above it; tiny slivers stay tooltip-only.
                const drawnTop = isTop ? topY : topY + SEG_GAP
                const h = bottomY - drawnTop
                if (h <= 0.5) return null
                return isTop ? (
                  <path key={s.key} d={cappedBarPath(x, drawnTop, barW, h)} fill={s.color} />
                ) : (
                  <rect key={`${s.key} ${k}`} x={x} y={drawnTop} width={barW} height={h} fill={s.color} />
                )
              })}
              {/* the hit target is the whole day slot, bigger than the marks */}
              <rect
                x={MARGIN.l + i * slot}
                y={MARGIN.t}
                width={slot}
                height={PLOT_H}
                fill="transparent"
                tabIndex={0}
                aria-label={`${day} ${fmtUsd(totalOfDay)}`}
                onPointerEnter={() => setHovered(i)}
                onFocus={() => setHovered(i)}
                onBlur={() => setHovered((h) => (h === i ? undefined : h))}
              />
              {i % labelEvery === 0 && (
                <text
                  x={MARGIN.l + i * slot + slot / 2}
                  y={H - 6}
                  textAnchor="middle"
                  className="fill-[var(--color-faint)] text-[10px] tabular-nums"
                >
                  {day.slice(5).replace('-', '/')}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {hovered !== undefined && hoveredDay !== undefined && (
        <div
          className="pointer-events-none absolute top-2 z-10 w-[176px] -translate-x-1/2 rounded-md border bg-popover p-2 text-[12px] shadow-[var(--pop-shadow)]"
          style={{ left: tooltipLeft }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="tabular-nums text-muted-foreground">{hoveredDay}</span>
            <span className="font-[560] tabular-nums text-foreground">{fmtUsd(dayTotals[hovered])}</span>
          </div>
          <div className="mt-1.5 space-y-1">
            {series.map((s, k) => (
              <div key={s.key} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <span
                    className="h-[3px] w-2.5 shrink-0 rounded-full"
                    style={{ background: s.color }}
                  />
                  <span className="truncate">{s.label}</span>
                </span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {fmtUsd(values[k]?.[hovered] ?? 0)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {series.length >= 2 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
