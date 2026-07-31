// Target dates are calendar dates stored as literal YYYY-MM-DD, and the control plane decides `onTime` by
// LEXICOGRAPHIC comparison (docs/tracker.md). The UI uses the same comparison so a badge can never disagree
// with the completion fact the history recorded. Shared with initiatives, which carry the same field.

export function todayInZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

// Past its target date. The caller decides whether that still matters — a completed container's deadline is
// history, not a warning.
export function isPastDue(targetDate: string | undefined, timeZone: string): boolean {
  if (!targetDate) return false
  return targetDate < todayInZone(timeZone)
}

// Did it land by the deadline? Same comparison the completion fact records as `onTime`.
export function metTargetDate(
  targetDate: string | undefined,
  completedAt: string | undefined
): boolean {
  if (!targetDate || !completedAt) return false
  return completedAt.slice(0, 10) <= targetDate
}
