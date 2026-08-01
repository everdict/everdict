import type { DashboardMetric } from '../model/schema'

// The agent sends a value and a baseline; the DELTA is derived here. Two reasons it is not the model's job.
// One, arithmetic: a model computing its own percentage change gets it wrong often enough to matter, and every
// card must round the same way. Two, meaning: a rise is not automatically good — cost and latency going up is
// a regression — so the color follows `higherIsBetter`, never the sign of the difference.

export type DeltaDirection = 'up' | 'down' | 'flat'
export type DeltaSentiment = 'good' | 'bad' | 'neutral'

export interface MetricDelta {
  direction: DeltaDirection
  sentiment: DeltaSentiment
  /** Signed magnitude with its unit, e.g. "4.2pt" / "17.8%". The arrow is the direction, rendered separately. */
  magnitude: string
}

const ARROW: Record<DeltaDirection, string> = { up: '▲', down: '▼', flat: '—' }

/** The arrow glyph for a direction — exported so the chip and its aria-label stay in step. */
export function deltaArrow(direction: DeltaDirection): string {
  return ARROW[direction]
}

// Below this the formatted magnitude would render as "0.0" anyway, so calling it a move would be noise.
const FLAT_EPSILON = 0.05

/**
 * Derive the delta for a metric, or null when it carries no baseline to compare against.
 * `formatValue` renders a bare number in the metric's unit (used only for the zero-baseline fallback).
 */
export function metricDelta(
  metric: DashboardMetric,
  formatValue: (value: number) => string
): MetricDelta | null {
  if (metric.baseline === undefined) return null
  const difference = metric.value - metric.baseline

  // A ratio moves in percentage POINTS — 58.2% → 62.4% is +4.2pt, not +7.2% — which is the difference between
  // a number a reader can check against the two values shown and one they cannot. Everything else moves in
  // relative percent, which is how a cost or a latency change is actually discussed. A zero baseline has no
  // relative form at all, so it falls back to the absolute difference in the metric's own unit.
  const relative =
    metric.unit === 'ratio'
      ? difference * 100
      : metric.baseline === 0
        ? null
        : (difference / Math.abs(metric.baseline)) * 100

  const flat = relative === null ? difference === 0 : Math.abs(relative) < FLAT_EPSILON
  const direction: DeltaDirection = flat ? 'flat' : difference > 0 ? 'up' : 'down'
  const sentiment: DeltaSentiment = flat
    ? 'neutral'
    : difference > 0 === (metric.higherIsBetter ?? true)
      ? 'good'
      : 'bad'
  const magnitude =
    relative === null
      ? formatValue(Math.abs(difference))
      : `${Math.abs(relative).toFixed(1)}${metric.unit === 'ratio' ? 'pt' : '%'}`

  return { direction, sentiment, magnitude }
}
