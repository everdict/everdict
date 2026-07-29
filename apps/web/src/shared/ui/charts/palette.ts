// The workspace's ONE categorical chart palette. The hues live in `globals.css` as `--chart-1..5` +
// `--chart-other`, stepped separately for the light and the dark card surface (not an automatic flip) and
// validated as a set for CVD separation, chroma, lightness band and contrast. Never hardcode a chart color
// anywhere else — every plotted mark in the app takes its color from here.
//
// Two rules make a chart honest across filter changes:
//  1. Slots are assigned in FIXED ORDER and never cycled. A 6th series is not a generated hue — it folds
//     into "other" (`--chart-other`, a neutral) so no two entities can share a slot.
//  2. Color follows the ENTITY, not its rank. Callers assign slots from a stable, unfiltered key list, so
//     narrowing the filter never repaints the survivors.

export const SERIES_SLOTS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const

export const OTHER_COLOR = 'var(--chart-other)'

/** How many entities can carry their own hue before the tail has to fold into "other". */
export const MAX_SERIES = SERIES_SLOTS.length

/** One plotted series: a stable identity, its display label, and the slot color bound to that identity. */
export interface ChartSeries {
  key: string
  label: string
  color: string
}

/** The slot for a fixed position — past the last slot, the neutral "other" color (never a generated hue). */
export function seriesColorAt(index: number): string {
  return SERIES_SLOTS[index] ?? OTHER_COLOR
}

/**
 * Split a ranked key list into the ones that get their own hue and the tail that folds into "other".
 * Pass the keys ranked over the WHOLE dataset (not the current filter) so slots stay stable while filtering.
 */
export function foldSeriesKeys(rankedKeys: readonly string[]): {
  lead: string[]
  folded: string[]
} {
  return { lead: [...rankedKeys.slice(0, MAX_SERIES)], folded: [...rankedKeys.slice(MAX_SERIES)] }
}
