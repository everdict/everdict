// 5-field cron utility — human-readable cadence description + next-fire computation. No dependencies (Intl-based, IANA tz·DST safe).
// The control plane / Temporal is the SSOT for actual firing — the computation here is an approximation for the schedule list's 'next run / upcoming runs' display.

const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'] as const
const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

interface CronMatcher {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean // day-of-month field is not '*'
  dowRestricted: boolean // day-of-week field is not '*'
}

// Expand one field (*, n, n-m, */k, n-m/k, comma list) into a set of matching values. undefined on a format error.
function parseField(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) return undefined
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = min
      hi = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-')
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = Number(rangePart)
      hi = lo
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi)
      return undefined
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return values
}

// cron expression → matcher. undefined if unparseable (the caller treats it as 'no next run').
export function parseCron(expr: string): CronMatcher | undefined {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return undefined
  const minute = parseField(parts[0], 0, 59)
  const hour = parseField(parts[1], 0, 23)
  const dom = parseField(parts[2], 1, 31)
  const month = parseField(parts[3], 1, 12)
  const dow = parseField(parts[4], 0, 7) // 7 = Sunday alias
  if (!minute || !hour || !dom || !month || !dow) return undefined
  if (dow.has(7)) dow.add(0) // normalize 7 → 0 (Sun) (wall-clock weekday is 0~6)
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  }
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  dow: number // 0=Sun ~ 6=Sat
}

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = fmtCache.get(timeZone)
  if (cached) return cached
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
  } catch {
    // Invalid IANA tz → fall back to UTC (the control plane validates precisely; here just keep the display from breaking).
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
  }
  fmtCache.set(timeZone, fmt)
  return fmt
}

// One UTC instant into the wall-clock fields of the given IANA tz. Since tz is explicit, it's deterministic on server/client (same result).
function wallClock(date: Date, timeZone: string): WallClock {
  const map: Record<string, string> = {}
  for (const p of formatterFor(timeZone).formatToParts(date)) map[p.type] = p.value
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24, // h23 = 0~23 (guard against some runtimes' 24-hour rendering)
    minute: Number(map.minute),
    dow: WEEKDAY[map.weekday] ?? 0,
  }
}

function fires(m: CronMatcher, w: WallClock): boolean {
  if (!m.minute.has(w.minute)) return false
  if (!m.hour.has(w.hour)) return false
  if (!m.month.has(w.month)) return false
  const dom = m.dom.has(w.day)
  const dow = m.dow.has(w.dow)
  // Vixie cron: if both day-of-week and day-of-month are restricted, OR; if only one is restricted, AND.
  if (m.domRestricted && m.dowRestricted) return dom || dow
  return dom && dow
}

// The next fire times after `from` (ascending). Scans minute by minute, filling `count` of them or up to the horizon.
export function nextFires(
  expr: string,
  timeZone: string,
  from: Date,
  opts: { count?: number; horizonDays?: number } = {}
): Date[] {
  const m = parseCron(expr)
  if (!m) return []
  const count = opts.count ?? 5
  const horizonMinutes = (opts.horizonDays ?? 7) * 24 * 60
  const out: Date[] = []
  const startMs = Math.ceil(from.getTime() / 60_000) * 60_000 // round up to the next minute boundary
  for (let i = 0; i <= horizonMinutes && out.length < count; i++) {
    const d = new Date(startMs + i * 60_000)
    if (fires(m, wallClock(d, timeZone))) out.push(d)
  }
  return out
}

// Whether this schedule fires at least once on the given calendar date (year-month-day) — checks only the month/day/dow fields (minute·hour irrelevant).
// For the calendar month view (O(1) per cell). The weekday is derived from the date, so it's a tz-agnostic approximation (midnight boundaries may be off).
export function firesOnDate(expr: string, year: number, month: number, day: number): boolean {
  const m = parseCron(expr)
  if (!m) return false
  if (!m.month.has(month)) return false
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay() // 0=Sun ~ 6=Sat
  const domMatch = m.dom.has(day)
  const dowMatch = m.dow.has(dow)
  // Vixie cron: if both day-of-week and day-of-month are restricted, OR; if only one is restricted, AND.
  if (m.domRestricted && m.dowRestricted) return domMatch || dowMatch
  return domMatch && dowMatch
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// cron expression into a human-readable cadence description. Maps only common shapes; complex expressions are returned as-is (also exposed as a code chip).
// locale is passed by the caller (component) via useLocale()/getLocale() (default ko) — format.ts convention.
export function describeCron(expr: string, locale: string = 'ko'): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [mi, ho, dom, mo, dow] = parts
  const ko = locale.startsWith('ko')
  const dowNames = ko ? DOW_KO : DOW_EN
  const isNum = (s: string) => /^\d+$/.test(s)
  const at = (h: string, m: string) => `${pad2(Number(h))}:${pad2(Number(m))}`
  const stepMin = /^\*\/(\d+)$/.exec(mi)
  if (stepMin && ho === '*' && dom === '*' && mo === '*' && dow === '*')
    return ko ? `${stepMin[1]}분마다` : `every ${stepMin[1]} min`
  if (isNum(mi) && ho === '*' && dom === '*' && mo === '*' && dow === '*') {
    if (mi === '0') return ko ? '매시간' : 'hourly'
    return ko ? `매시간 ${Number(mi)}분` : `hourly at :${pad2(Number(mi))}`
  }
  if (isNum(mi) && isNum(ho) && dom === '*' && mo === '*' && dow === '*')
    return ko ? `매일 ${at(ho, mi)}` : `daily at ${at(ho, mi)}`
  if (isNum(mi) && isNum(ho) && dom === '*' && mo === '*') {
    if (dow === '1-5') return ko ? `평일 ${at(ho, mi)}` : `weekdays at ${at(ho, mi)}`
    if (dow === '0,6' || dow === '6,0' || dow === '6,7' || dow === '0,7')
      return ko ? `주말 ${at(ho, mi)}` : `weekends at ${at(ho, mi)}`
    if (isNum(dow)) {
      const day = dowNames[Number(dow) % 7]
      return ko ? `매주 ${day} ${at(ho, mi)}` : `every ${day} at ${at(ho, mi)}`
    }
    if (/^[0-7](,[0-7])*$/.test(dow)) {
      const days = dow
        .split(',')
        .map((d) => dowNames[Number(d) % 7])
        .join(ko ? '·' : ', ')
      return ko ? `매주 ${days} ${at(ho, mi)}` : `every ${days} at ${at(ho, mi)}`
    }
  }
  if (isNum(mi) && isNum(ho) && isNum(dom) && mo === '*' && dow === '*')
    return ko
      ? `매월 ${Number(dom)}일 ${at(ho, mi)}`
      : `day ${Number(dom)} monthly at ${at(ho, mi)}`
  return expr
}

// A fire instant (ISO) into 'HH:MM' in that schedule's tz. Explicit tz → identical on server/client (hydration-safe).
export function fireTimeLabel(iso: string, timeZone: string): string {
  const w = wallClock(new Date(iso), timeZone)
  return `${pad2(w.hour)}:${pad2(w.minute)}`
}

// A fire instant into a relative date label vs now (today/tomorrow/MM-DD). All calendar dates are compared in the schedule's tz.
// locale is passed by the caller (default ko) — format.ts convention.
export function fireDayLabel(
  iso: string,
  nowIso: string,
  timeZone: string,
  locale: string = 'ko'
): string {
  const f = wallClock(new Date(iso), timeZone)
  const n = wallClock(new Date(nowIso), timeZone)
  const diff = Math.round(
    (Date.UTC(f.year, f.month - 1, f.day) - Date.UTC(n.year, n.month - 1, n.day)) / 86_400_000
  )
  const ko = locale.startsWith('ko')
  if (diff <= 0) return ko ? '오늘' : 'today'
  if (diff === 1) return ko ? '내일' : 'tomorrow'
  return `${pad2(f.month)}-${pad2(f.day)}`
}
