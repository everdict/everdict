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

// ── Hierarchical judge metric labels (docs/architecture/eval-domain-model.md) ────────────────
// `judge` / `judge:<judgeId>` = a judge's overall verdict; `judge:<judgeId>:<criterionId>` /
// `judge:<criterionId>` (inline case-embedded judge) = one criterion of a multi-criteria judge.
// The 2-segment form is ambiguous — disambiguate within one scorecard via siblings:
// `judge:<x>` alongside `judge:<x>:<y>` is an overall with criteria; alongside a bare `judge`
// it is an inline-judge criterion; otherwise it is just an overall.
export type ParsedMetric =
  | { kind: 'plain'; metric: string }
  | { kind: 'judge-overall'; metric: string; judgeId?: string }
  | { kind: 'judge-criterion'; metric: string; judgeId?: string; criterionId: string }

export function parseMetricLabel(metric: string, siblings?: readonly string[]): ParsedMetric {
  if (metric === 'judge') return { kind: 'judge-overall', metric } // inline judge overall
  if (!metric.startsWith('judge:')) return { kind: 'plain', metric }
  const rest = metric.slice('judge:'.length)
  const sep = rest.indexOf(':')
  if (sep >= 0) {
    const judgeId = rest.slice(0, sep)
    const criterionId = rest.slice(sep + 1)
    if (!judgeId || !criterionId) return { kind: 'plain', metric } // malformed — keep the raw label
    return { kind: 'judge-criterion', metric, judgeId, criterionId }
  }
  if (!rest) return { kind: 'plain', metric } // malformed 'judge:' — keep the raw label
  const sib = siblings ?? []
  if (sib.some((s) => s.startsWith(`${metric}:`)))
    return { kind: 'judge-overall', metric, judgeId: rest }
  if (sib.includes('judge')) return { kind: 'judge-criterion', metric, criterionId: rest }
  return { kind: 'judge-overall', metric, judgeId: rest }
}

// Text form for string-only slots (combobox options, code chips, table headers) — 'judge <id> › <criterion>'.
// Plain metrics pass through unchanged.
export function fmtMetricLabel(metric: string, siblings?: readonly string[]): string {
  const p = parseMetricLabel(metric, siblings)
  if (p.kind === 'plain') return p.metric
  const head = p.judgeId ? `judge ${p.judgeId}` : 'judge'
  return p.kind === 'judge-criterion' ? `${head} › ${p.criterionId}` : head
}

// Group metric-keyed rows for display — criterion rows nest under their judge's overall row
// (overall first, criteria beneath in stable label order). Non-judge rows keep their original order;
// an orphan criterion (no overall row present) stays top-level.
export interface MetricRowGroup<T extends { metric: string }> {
  row: T
  parsed: ParsedMetric
  criteria: { row: T; parsed: ParsedMetric }[]
}
export function groupMetricRows<T extends { metric: string }>(
  rows: readonly T[]
): MetricRowGroup<T>[] {
  const siblings = rows.map((r) => r.metric)
  const entries = rows.map((row) => ({ row, parsed: parseMetricLabel(row.metric, siblings) }))
  const groups: MetricRowGroup<T>[] = []
  const byMetric = new Map<string, MetricRowGroup<T>>()
  for (const e of entries) {
    if (e.parsed.kind === 'judge-criterion') continue
    const group = { ...e, criteria: [] }
    groups.push(group)
    byMetric.set(e.row.metric, group)
  }
  for (const e of entries) {
    if (e.parsed.kind !== 'judge-criterion') continue
    const parentMetric = e.parsed.judgeId ? `judge:${e.parsed.judgeId}` : 'judge'
    const parent = byMetric.get(parentMetric)
    if (parent) parent.criteria.push(e)
    else groups.push({ ...e, criteria: [] }) // orphan — appended after the regular rows
  }
  for (const g of groups) g.criteria.sort((a, b) => a.row.metric.localeCompare(b.row.metric))
  return groups
}

// Compact time 'MM-DD HH:mm' (value is UTC — precise/local supplemented via title). If not ISO, pass through.
export function fmtDateTime(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso
  return iso
    .replace('T', ' ')
    .replace(/\.\d+Z?$/, '')
    .slice(5, 16)
}
// Trace/observability duration — sub-second in ms, else s / m·s (compact, tabular). '–' for unknown.
export function fmtDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '–'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}
// Compact token count for a metrics column (1_234 → 1.2k). '–' for unknown.
export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '–'
  if (n < 1000) return String(Math.round(n))
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
}
// USD cost, 3-4 significant places for the small numbers eval traces produce. '–' for unknown.
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '–'
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
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
