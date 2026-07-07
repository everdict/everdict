// Shared dashboard formatting — score/time/health rendering in one place (unifying what used to differ per page).

export function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`
}

// Score = passRate first (%), else mean (2f), else '–'. Shared across list/leaderboard/trend/detail.
export function fmtScore(
  passRate: number | null | undefined,
  mean: number | null | undefined
): string {
  if (passRate != null) return fmtPct(passRate)
  if (mean != null) return mean.toFixed(2)
  return '–'
}

// Pass-rate health — for color encoding. Only meaningful for passRate (0~1); numeric metrics are 'none' = neutral.
export type Health = 'good' | 'mid' | 'low' | 'none'
export function rateHealth(passRate: number | null | undefined): Health {
  if (passRate == null) return 'none'
  if (passRate >= 0.75) return 'good'
  if (passRate >= 0.4) return 'mid'
  return 'low'
}
export const HEALTH_TEXT: Record<Health, string> = {
  good: 'text-[var(--color-success)]',
  mid: 'text-[var(--color-warning)]',
  low: 'text-destructive',
  none: 'text-foreground',
}

// Compact time 'MM-DD HH:mm' (value is UTC — precise/local supplemented via title). If not ISO, pass through.
export function fmtDateTime(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso
  return iso
    .replace('T', ' ')
    .replace(/\.\d+Z?$/, '')
    .slice(5, 16)
}
// Local full rendering for title= (exact time on hover).
export function fmtDateTimeFull(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

// An opaque subject (e.g. Keycloak sub) isn't human-readable, so abbreviate it. Prefer the members-joined name where possible,
// and use this only as the fallback when no name is available (shared creator/author rendering).
export function fmtSubject(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s
}

// Relative time (for feeds like notifications) — Intl.RelativeTimeFormat locale rendering (e.g. '3 minutes ago'),
// falling back to an absolute date past 7 days. locale is passed by the caller (component) via useLocale()/getLocale() (default ko).
export function fmtTimeAgo(iso: string, locale: string = 'ko'): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return fmtDateTime(iso)
  const min = Math.floor(ms / 60_000)
  if (min < 1) return locale.startsWith('ko') ? '방금 전' : 'just now'
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' })
  if (min < 60) return rtf.format(-min, 'minute')
  const hours = Math.floor(min / 60)
  if (hours < 24) return rtf.format(-hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days <= 7) return rtf.format(-days, 'day')
  return fmtDateTime(iso)
}

// List date-group header — today/yesterday as relative (numeric:auto), otherwise locale month·day (include the year in a different year).
export function fmtDateHeading(iso: string, locale: string = 'ko'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (diffDays === 0 || diffDays === 1)
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-diffDays, 'day')
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: 'long', day: 'numeric' }
      : { year: 'numeric', month: 'long', day: 'numeric' }
  return new Intl.DateTimeFormat(locale, opts).format(d)
}

// Time for a date-group row — HH:MM (local). The date lives in the group header.
export function fmtTimeOnly(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Date-group key (based on local midnight) — the same day yields the same key.
export function dayKeyOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
