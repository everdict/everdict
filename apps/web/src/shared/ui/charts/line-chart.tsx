'use client'

import { useMemo, useState } from 'react'

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

// Multi-series line — change over time. `values[seriesIndex][xIndex]`, where null means "no data at this
// bucket" and BREAKS the line: joining across a gap would draw a measurement that was never taken.

const MARKER_R = 4 // >= 8px mark
const DENSE_POINTS = 24 // past this, per-point markers become noise — the hover layer carries them instead

interface Segment {
  from: number
  points: { i: number; v: number }[]
}

function segmentsOf(points: (number | null | undefined)[]): Segment[] {
  const out: Segment[] = []
  let current: Segment | undefined
  points.forEach((v, i) => {
    if (v === null || v === undefined) {
      current = undefined
      return
    }
    if (!current) {
      current = { from: i, points: [] }
      out.push(current)
    }
    current.points.push({ i, v })
  })
  return out
}

export function LineChart({
  x,
  series,
  values,
  formatValue,
  formatX,
  domain,
  ariaLabel,
  emptyLabel,
  onSelect,
}: {
  x: string[]
  series: ChartSeries[]
  values: (number | null | undefined)[][]
  formatValue: (v: number) => string
  formatX?: (label: string, index: number) => string
  /** Pin the y domain — pass `{min: 0, max: 1}` for a ratio so 0–100% is always the frame of reference. */
  domain?: { min: number; max: number }
  ariaLabel: string
  emptyLabel: string
  /** Drill into a bucket. The whole column is the hit target, and it is keyboard reachable. */
  onSelect?: (xIndex: number) => void
}) {
  const [wrapRef, width] = useMeasuredWidth()
  const [hovered, setHovered] = useState<number>()

  const flat = useMemo(
    () => values.flat().filter((v): v is number => typeof v === 'number'),
    [values]
  )
  const scale = useMemo(
    () => niceScale(Math.min(...flat, 0), Math.max(...flat, 0), domain ? { fixed: domain } : {}),
    [flat, domain]
  )

  const plotWidth = Math.max(40, width - CHART.marginLeft - CHART.marginRight)
  const n = x.length
  const baseline = CHART.marginTop + CHART.plotHeight
  const span = scale.top - scale.bottom || 1
  const xOf = (i: number) => CHART.marginLeft + (n <= 1 ? plotWidth / 2 : (i * plotWidth) / (n - 1))
  const yOf = (v: number) => baseline - ((v - scale.bottom) / span) * CHART.plotHeight
  const slot = plotWidth / Math.max(1, n)

  if (flat.length === 0) {
    return (
      <div ref={wrapRef}>
        <ChartEmpty label={emptyLabel} />
      </div>
    )
  }

  const showMarkers = n <= DENSE_POINTS

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

        {hovered !== undefined && (
          <line
            x1={xOf(hovered)}
            x2={xOf(hovered)}
            y1={CHART.marginTop}
            y2={baseline}
            stroke="var(--color-border-strong)"
            strokeWidth={1}
          />
        )}

        {series.map((s, si) => {
          const points = values[si] ?? []
          return (
            <g key={s.key}>
              {segmentsOf(points).map((seg) => (
                <polyline
                  key={seg.from}
                  points={seg.points.map((p) => `${xOf(p.i)},${yOf(p.v)}`).join(' ')}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {segmentsOf(points).map((seg) =>
                // A lone point has no line to belong to, so it is always drawn; the rest only when sparse
                // enough to stay legible. The 2px surface ring keeps a dot readable where series overlap.
                seg.points.map((p) =>
                  showMarkers || seg.points.length === 1 || hovered === p.i ? (
                    <circle
                      key={p.i}
                      cx={xOf(p.i)}
                      cy={yOf(p.v)}
                      r={MARKER_R}
                      fill={s.color}
                      stroke="var(--color-card)"
                      strokeWidth={2}
                    />
                  ) : null
                )
              )}
            </g>
          )
        })}

        {x.map((label, i) => (
          // The hit target is the whole column — wider than any mark, and focusable so keyboard reaches
          // exactly what hover reaches.
          <rect
            key={`${label}-${i}`}
            x={CHART.marginLeft + i * slot}
            y={CHART.marginTop}
            width={slot}
            height={CHART.plotHeight}
            fill="transparent"
            tabIndex={0}
            role={onSelect ? 'button' : undefined}
            aria-label={label}
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
        ))}

        <XAxisLabels
          labels={x}
          xOf={xOf}
          plotWidth={plotWidth}
          {...(formatX ? { format: formatX } : {})}
        />
      </svg>

      {hovered !== undefined && (
        <ChartTooltip left={clampTooltip(xOf(hovered), width)}>
          <div className="mb-1.5 tabular-nums text-muted-foreground">{x[hovered]}</div>
          <div className="space-y-1">
            {series.map((s, si) => {
              const v = values[si]?.[hovered]
              return (
                <TooltipRow
                  key={s.key}
                  color={s.color}
                  label={s.label}
                  value={typeof v === 'number' ? formatValue(v) : '—'}
                  dimmed={typeof v !== 'number'}
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
