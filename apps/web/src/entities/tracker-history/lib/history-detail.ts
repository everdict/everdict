// A history entry's `detail` is a free shape that differs per event (`Record<string, unknown>`) — a status change carries from/to, a link
// carries type/id, a completion carries forced/openIssues. Without narrowing on the READING side the screen simply breaks, so every read passes
// through these four: a different shape is treated as having no value, and only that chip disappears.
export type HistoryDetail = Record<string, unknown> | undefined

export function detailString(detail: HistoryDetail, key: string): string | undefined {
  const value = detail?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Keeps only a string-array field (`changed`) — a non-array, or an element that is not a string, has that element discarded.
export function detailStrings(detail: HistoryDetail, key: string): string[] {
  const value = detail?.[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

export function detailNumber(detail: HistoryDetail, key: string): number | undefined {
  const value = detail?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// True only when it is literally `true` — the string "true" or 1 is not a flag (it is stricter because these values raise alarms, like a forced completion).
export function detailFlag(detail: HistoryDetail, key: string): boolean {
  return detail?.[key] === true
}
