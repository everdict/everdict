'use client'

import { useState } from 'react'

import {
  CHART,
  CHART_HEIGHT,
  ChartEmpty,
  ChartLegend,
  ChartTooltip,
  clampTooltip,
  GridLines,
  niceScale,
  TooltipRow,
  useMeasuredWidth,
  XAxisLabels,
} from './chart-frame'
import type { ChartSeries } from './palette'

// Column chart — magnitude per category, grouped (series side by side) or stacked (series summed per column).
// Bars always grow from the zero baseline, so a bar's length is its value and nothing else.

const CORNER_R = 4

/** 4px rounded data end, square at the baseline. A negative bar rounds at the bottom — its data end is down. */
function barPath(
  x: number,
  top: number,
  w: number,
  h: number,
  corner: 'top' | 'bottom' | 'none'
): string {
  const r = Math.max(0, Math.min(CORNER_R, w / 2, h))
  const bottom = top + h
  if (corner === 'none' || r === 0)
    return `M ${x} ${top} L ${x + w} ${top} L ${x + w} ${bottom} L ${x} ${bottom} Z`
  if (corner === 'top')
    return `M ${x} ${bottom} L ${x} ${top + r} Q ${x} ${top} ${x + r} ${top} L ${x + w - r} ${top} Q ${x + w} ${top} ${x + w} ${top + r} L ${x + w} ${bottom} Z`
  return `M ${x} ${top} L ${x + w} ${top} L ${x + w} ${bottom - r} Q ${x + w} ${bottom} ${x + w - r} ${bottom} L ${x + r} ${bottom} Q ${x} ${bottom} ${x} ${bottom - r} Z`
}

export function BarChart({
  x,
  series,
  values,
  stacked = false,
  formatValue,
  formatX,
  domain,
  ariaLabel,
  emptyLabel,
  showTotal = false,
  onSelect,
}: {
  x: string[]
  series: ChartSeries[]
  values: (number | null | undefined)[][]
  stacked?: boolean
  formatValue: (v: number) => string
  formatX?: (label: string, index: number) => string
  domain?: { min: number; max: number }
  ariaLabel: string
  emptyLabel: string
  /** Stacked only: lead the tooltip with the column total (the sum the stack represents). */
  showTotal?: boolean
  onSelect?: (xIndex: number) => void
}) {
  const [wrapRef, width] = useMeasuredWidth()
  const [hovered, setHovered] = useState<number>()

  const at = (si: number, i: number): number => {
    const v = values[si]?.[i]
    return typeof v === 'number' ? v : 0
  }
  const defined = (si: number, i: number): boolean => typeof values[si]?.[i] === 'number'

  // Small fixed-size reductions (columns × series) — cheap enough that memoising them would cost more
  // in dependency bookkeeping than it saves.
  const totals = x.map((_, i) => series.reduce((sum, _s, si) => sum + at(si, i), 0))
  const flat = values.flat().filter((v): v is number => typeof v === 'number')
  const extent = stacked
    ? { min: Math.min(0, ...totals), max: Math.max(0, ...totals) }
    : { min: Math.min(0, ...flat), max: Math.max(0, ...flat) }

  const scale = niceScale(extent.min, extent.max, domain ? { fixed: domain } : {})

  const plotWidth = Math.max(40, width - CHART.marginLeft - CHART.marginRight)
  const n = x.length
  const baseline = CHART.marginTop + CHART.plotHeight
  const spanY = scale.top - scale.bottom || 1
  const yOf = (v: number) => baseline - ((v - scale.bottom) / spanY) * CHART.plotHeight
  const zeroY = yOf(0)
  const slot = plotWidth / Math.max(1, n)

  const anyValue = values.some((row) => row.some((v) => typeof v === 'number' && v !== 0))
  if (!anyValue) {
    return (
      <div ref={wrapRef}>
        <ChartEmpty label={emptyLabel} />
      </div>
    )
  }

  const groupWidth = Math.min(slot * 0.72, CHART.maxBarWidth * series.length)
  const barWidth = stacked
    ? Math.min(CHART.maxBarWidth, Math.max(2, slot - CHART.segmentGap))
    : Math.max(2, groupWidth / series.length - CHART.segmentGap)
  const columnLeft = (i: number) =>
    stacked
      ? CHART.marginLeft + i * slot + (slot - barWidth) / 2
      : CHART.marginLeft + i * slot + (slot - groupWidth) / 2
  const columnCenter = (i: number) => CHART.marginLeft + i * slot + slot / 2

  return (
    <div ref={wrapRef} className="relative">
      <svg
        width={width}
        height={CHART_HEIGHT}
        role="img"
        aria-label={ariaLabel}
        className="block"
        onPointerLeave={() => setHovered(undefined)}
      >
        <GridLines
          scale={scale}
          yOf={yOf}
          left={CHART.marginLeft}
          width={plotWidth}
          format={formatValue}
        />

        {x.map((label, i) => {
          const left = columnLeft(i)
          return (
            <g key={`${label}-${i}`}>
              {hovered === i && (
                <rect
                  x={CHART.marginLeft + i * slot}
                  y={CHART.marginTop}
                  width={slot}
                  height={CHART.plotHeight}
                  fill="var(--color-muted)"
                />
              )}

              {stacked
                ? (() => {
                    // Only non-zero segments are drawn, so the topmost DRAWN one carries the rounded cap.
                    const parts = series
                      .map((s, si) => ({ s, v: at(si, i) }))
                      .filter((p) => p.v > 0)
                    let cumulative = 0
                    return parts.map((p, idx) => {
                      const isTop = idx === parts.length - 1
                      const bottomY = yOf(cumulative)
                      cumulative += p.v
                      const topY = yOf(cumulative)
                      // The 2px gap belongs to the surface, not to a stroke around the segment.
                      const drawnTop = isTop ? topY : topY + CHART.segmentGap
                      const h = bottomY - drawnTop
                      if (h <= 0.5) return null // a sliver thinner than the gap stays tooltip-only
                      return (
                        <path
                          key={p.s.key}
                          d={barPath(left, drawnTop, barWidth, h, isTop ? 'top' : 'none')}
                          fill={p.s.color}
                        />
                      )
                    })
                  })()
                : series.map((s, si) => {
                    if (!defined(si, i)) return null
                    const v = at(si, i)
                    const top = Math.min(yOf(v), zeroY)
                    const h = Math.abs(yOf(v) - zeroY)
                    if (h < 0.5) return null
                    return (
                      <path
                        key={s.key}
                        d={barPath(
                          left + si * (barWidth + CHART.segmentGap),
                          top,
                          barWidth,
                          h,
                          v < 0 ? 'bottom' : 'top'
                        )}
                        fill={s.color}
                      />
                    )
                  })}

              <rect
                x={CHART.marginLeft + i * slot}
                y={CHART.marginTop}
                width={slot}
                height={CHART.plotHeight}
                fill="transparent"
                tabIndex={0}
                role={onSelect ? 'button' : undefined}
                aria-label={`${label} ${formatValue(totals[i] ?? 0)}`}
                className={onSelect ? 'cursor-pointer' : undefined}
                onPointerEnter={() => setHovered(i)}
                onFocus={() => setHovered(i)}
                onBlur={() => setHovered((h) => (h === i ? undefined : h))}
                onClick={onSelect ? () => onSelect(i) : undefined}
                onKeyDown={
                  onSelect
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onSelect(i)
                        }
                      }
                    : undefined
                }
              />
            </g>
          )
        })}

        <XAxisLabels
          labels={x}
          xOf={columnCenter}
          plotWidth={plotWidth}
          {...(formatX ? { format: formatX } : {})}
        />
      </svg>

      {hovered !== undefined && (
        <ChartTooltip left={clampTooltip(columnCenter(hovered), width)}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="tabular-nums text-muted-foreground">{x[hovered]}</span>
            {stacked && showTotal && (
              <span className="font-[560] tabular-nums text-foreground">
                {formatValue(totals[hovered] ?? 0)}
              </span>
            )}
          </div>
          <div className="mt-1.5 space-y-1">
            {series.map((s, si) => {
              const has = defined(si, hovered)
              return (
                <TooltipRow
                  key={s.key}
                  color={s.color}
                  label={s.label}
                  value={has ? formatValue(at(si, hovered)) : '—'}
                  dimmed={!has}
                />
              )
            })}
          </div>
        </ChartTooltip>
      )}

      <ChartLegend series={series} />
    </div>
  )
}
