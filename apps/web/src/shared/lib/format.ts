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

// Score.detail is `unknown` on the wire — graders/judges may emit prose OR a structured verdict object.
// Prose renders as-is; anything else degrades to compact JSON so a structured detail never breaks the page.
export function fmtScoreDetail(detail: unknown): string | undefined {
  if (detail == null) return undefined
  if (typeof detail === 'string') return detail || undefined
  return JSON.stringify(detail)
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

// Compact label for contexts where the judge is already known (its own detail page) — drops the
// redundant 'judge <id>' head: overall → '' (the value alone reads clearly), criterion → the bare
// criterion id. Plain metrics pass through unchanged.
export function fmtMetricLabelCompact(metric: string, siblings?: readonly string[]): string {
  const p = parseMetricLabel(metric, siblings)
  if (p.kind === 'plain') return p.metric
  return p.kind === 'judge-criterion' ? p.criterionId : ''
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

// ── Timezone-aware wall-clock extraction ─────────────────────────────────────────────────────
// The user's display timezone is a per-device preference (features/switch-timezone → next-intl timeZone).
// Components read it with useTimeZone()/getTimeZone() and thread it into the date atoms below, exactly as they
// already thread locale. When a `timeZone` is omitted these keep their prior behavior (UTC string slice / the
// browser's local zone) so callers migrate incrementally without a break.
const zonedFmtCache = new Map<string, Intl.DateTimeFormat>()
function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zonedFmtCache.get(timeZone)
  if (cached) return cached
  const opts: Intl.DateTimeFormatOptions = {
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, ...opts })
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }) // invalid tz → keep the display from breaking
  }
  zonedFmtCache.set(timeZone, fmt)
  return fmt
}
interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}
function wallClockIn(d: Date, timeZone: string): WallClock {
  const m: Record<string, string> = {}
  for (const p of zonedFormatter(timeZone).formatToParts(d)) m[p.type] = p.value
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour: Number(m.hour) % 24, // h23 = 0~23 (guard against some runtimes rendering 24)
    minute: Number(m.minute),
  }
}
const pad2 = (n: number) => String(n).padStart(2, '0')

// Compact time 'MM-DD HH:mm'. With a `timeZone` the wall-clock is that zone's; without one the value's UTC fields
// are sliced from the ISO string (prior behavior). If not ISO, pass through.
export function fmtDateTime(iso: string, timeZone?: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso
  if (timeZone) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const w = wallClockIn(d, timeZone)
    return `${pad2(w.month)}-${pad2(w.day)} ${pad2(w.hour)}:${pad2(w.minute)}`
  }
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

// ── Metric-kind classification + kind-aware value formatting ─────────────────────────────────
// A Score's `value` is always a bare number, but a metric can MEAN many things — a pass/fail, a percentage, a cost,
// a latency, a count, or (with a `label`) a category/tier. We infer the kind so the dashboard formats each with the
// right unit/visual instead of a uniform "0.50". Inference-based (no declared `kind` on Score) — the categorical and
// pass/fail signals come from the DATA (a label / a passRate), the numeric units from the metric NAME.
export type MetricKind =
  | 'categorical' // scores carry a label → a distribution of tiers/strings (bronze/silver/gold, correct/partial/wrong)
  | 'passfail' // scores carry pass → a boolean/objective metric summarized as a pass rate
  | 'currency' // cost/usd/price → $
  | 'duration' // latency/duration/elapsed/_ms → 12.4s (value is milliseconds)
  | 'tokens' // token counts → 1.2k
  | 'count' // steps/tool_calls/turns → integer
  | 'percent' // accuracy/rate/precision/recall/f1/ratio, or a bare 0..1 mean → %
  | 'plain' // anything else → 2-decimal number

// Strip a judge-metric prefix (judge:<id>:<criterion>) down to the trailing segment for name-based unit inference.
function metricUnitName(metric: string): string {
  const seg = metric.includes(':') ? metric.slice(metric.lastIndexOf(':') + 1) : metric
  return seg.toLowerCase()
}

export function classifyMetric(s: {
  metric: string
  passRate?: number | null
  distribution?: readonly unknown[] | null
  mean?: number | null
}): MetricKind {
  if (s.distribution && s.distribution.length > 0) return 'categorical'
  if (s.passRate != null) return 'passfail'
  const m = metricUnitName(s.metric)
  if (/cost|usd|price/.test(m)) return 'currency'
  if (/latency|duration|elapsed|_ms$|^ms$|millis/.test(m)) return 'duration'
  if (/token/.test(m)) return 'tokens'
  if (/steps|tool_calls|turns|calls|count/.test(m)) return 'count'
  if (/rate|accuracy|precision|recall|ratio|percent|pct|f1/.test(m)) return 'percent'
  if (s.mean != null && s.mean >= 0 && s.mean <= 1) return 'percent' // bare 0..1 → read as a fraction
  return 'plain'
}

// Format a numeric metric value (a mean, or a single case's value) for its inferred kind. Categorical metrics are
// NOT formatted here — they render as a distribution (their `value` is only an ordering key). percent/passfail
// expect a 0..1 fraction; duration expects milliseconds.
export function fmtMetricValue(kind: MetricKind, value: number): string {
  switch (kind) {
    case 'currency':
      return fmtUsd(value)
    case 'duration':
      return fmtDurationMs(value)
    case 'tokens':
      return fmtTokens(value)
    case 'percent':
    case 'passfail':
      return fmtPct(value)
    case 'count':
      return Number.isInteger(value) ? String(value) : value.toFixed(1)
    default:
      return value.toFixed(2)
  }
}

// Full rendering for title= (exact time on hover). locale/timeZone come from the caller (useLocale()/useTimeZone()
// or the server equivalents); omitted → the browser's defaults (prior behavior).
export function fmtDateTimeFull(
  iso: string,
  opts: { locale?: string; timeZone?: string } = {}
): string {
  try {
    return new Date(iso).toLocaleString(
      opts.locale,
      opts.timeZone ? { timeZone: opts.timeZone } : undefined
    )
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
export function fmtTimeAgo(iso: string, locale: string = 'ko', timeZone?: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return fmtDateTime(iso, timeZone)
  const min = Math.floor(ms / 60_000)
  if (min < 1) return locale.startsWith('ko') ? '방금 전' : 'just now'
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' })
  if (min < 60) return rtf.format(-min, 'minute')
  const hours = Math.floor(min / 60)
  if (hours < 24) return rtf.format(-hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days <= 7) return rtf.format(-days, 'day')
  return fmtDateTime(iso, timeZone)
}

// List date-group header — today/yesterday as relative (numeric:auto), otherwise locale month·day (include the year in a different year).
// The today/yesterday boundary and the month·day are computed in `timeZone` when given, else the browser's local zone.
export function fmtDateHeading(iso: string, locale: string = 'ko', timeZone?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = new Date()
  // Midnight-aligned day ordinal in the display zone (UTC-based so the subtraction is zone-neutral once shifted).
  const dayOrdinal = (x: Date) => {
    if (timeZone) {
      const w = wallClockIn(x, timeZone)
      return Date.UTC(w.year, w.month - 1, w.day)
    }
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  }
  const diffDays = Math.round((dayOrdinal(now) - dayOrdinal(d)) / 86_400_000)
  if (diffDays === 0 || diffDays === 1)
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-diffDays, 'day')
  const yearOf = (x: Date) => (timeZone ? wallClockIn(x, timeZone).year : x.getFullYear())
  const base: Intl.DateTimeFormatOptions =
    yearOf(d) === yearOf(now)
      ? { month: 'long', day: 'numeric' }
      : { year: 'numeric', month: 'long', day: 'numeric' }
  return new Intl.DateTimeFormat(locale, timeZone ? { ...base, timeZone } : base).format(d)
}

// Time for a date-group row — HH:MM in the display zone (`timeZone`), else the browser's local zone. The date lives in the group header.
export function fmtTimeOnly(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  if (timeZone) {
    const w = wallClockIn(d, timeZone)
    return `${pad2(w.hour)}:${pad2(w.minute)}`
  }
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// Date-group key (display-zone midnight) — the same day yields the same key. Must share `timeZone` with fmtDateHeading/fmtTimeOnly.
export function dayKeyOf(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  if (timeZone) {
    const w = wallClockIn(d, timeZone)
    return `${w.year}-${w.month}-${w.day}`
  }
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
