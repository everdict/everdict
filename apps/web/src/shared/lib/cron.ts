// 5-field cron 유틸 — 사람이 읽는 주기 설명 + 다음 발사 시각 계산. 의존성 없음(Intl 기반, IANA tz·DST 안전).
// 컨트롤플레인/Temporal 이 실제 발사의 SSOT — 여기 계산은 예약 목록의 '다음 실행/다가오는 실행' 표시용 근사다.

const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'] as const
const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

interface CronMatcher {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean // day-of-month 필드가 '*' 가 아님
  dowRestricted: boolean // day-of-week 필드가 '*' 가 아님
}

// 한 필드(*, n, n-m, */k, n-m/k, 콤마 리스트)를 매칭 값 집합으로 확장. 형식 오류면 undefined.
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

// cron 식 → 매칭기. 파싱 불가하면 undefined(호출부는 '다음 실행 없음'으로 처리).
export function parseCron(expr: string): CronMatcher | undefined {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return undefined
  const minute = parseField(parts[0], 0, 59)
  const hour = parseField(parts[1], 0, 23)
  const dom = parseField(parts[2], 1, 31)
  const month = parseField(parts[3], 1, 12)
  const dow = parseField(parts[4], 0, 7) // 7 = 일요일 별칭
  if (!minute || !hour || !dom || !month || !dow) return undefined
  if (dow.has(7)) dow.add(0) // 7 → 0(일)로 정규화(벽시계 요일은 0~6)
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
  dow: number // 0=일 ~ 6=토
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
    // 잘못된 IANA tz → UTC 로 폴백(컨트롤플레인이 정밀 검증; 여기선 표시가 깨지지 않게만).
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

// 한 UTC 순간을 주어진 IANA tz 의 벽시계 필드로. tz 를 명시하므로 서버/클라이언트에서 결정적(동일 결과).
function wallClock(date: Date, timeZone: string): WallClock {
  const map: Record<string, string> = {}
  for (const p of formatterFor(timeZone).formatToParts(date)) map[p.type] = p.value
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24, // h23 = 0~23 (일부 런타임의 24시 표기 방어)
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
  // Vixie cron: 요일·일 둘 다 제한되면 OR, 하나만 제한이면 AND.
  if (m.domRestricted && m.dowRestricted) return dom || dow
  return dom && dow
}

// from 이후의 다음 발사 시각들(오름차순). 분 단위로 스캔하며 count 개를 채우거나 horizon 까지.
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
  const startMs = Math.ceil(from.getTime() / 60_000) * 60_000 // 다음 분 경계로 올림
  for (let i = 0; i <= horizonMinutes && out.length < count; i++) {
    const d = new Date(startMs + i * 60_000)
    if (fires(m, wallClock(d, timeZone))) out.push(d)
  }
  return out
}

// 주어진 달력 날짜(연-월-일)에 이 예약이 한 번이라도 발사되는가 — 월/일/요일 필드만 확인(분·시 무관).
// 캘린더 월뷰용(셀당 O(1)). 요일은 날짜에서 결정하므로 tz 무관 근사(자정 경계는 오차 가능).
export function firesOnDate(expr: string, year: number, month: number, day: number): boolean {
  const m = parseCron(expr)
  if (!m) return false
  if (!m.month.has(month)) return false
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay() // 0=일 ~ 6=토
  const domMatch = m.dom.has(day)
  const dowMatch = m.dow.has(dow)
  // Vixie cron: 요일·일 둘 다 제한이면 OR, 하나만 제한이면 AND.
  if (m.domRestricted && m.dowRestricted) return domMatch || dowMatch
  return domMatch && dowMatch
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// cron 식을 사람이 읽는 주기 설명으로. 흔한 형태만 매핑하고, 복잡한 식은 원본 그대로(코드 칩으로도 노출됨).
// locale 은 호출부(컴포넌트)가 useLocale()/getLocale() 로 넘긴다(기본 ko) — format.ts 관례.
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

// 발사 순간(ISO)을 그 예약의 tz 기준 'HH:MM'로. tz 명시 → 서버/클라 동일(hydration 안전).
export function fireTimeLabel(iso: string, timeZone: string): string {
  const w = wallClock(new Date(iso), timeZone)
  return `${pad2(w.hour)}:${pad2(w.minute)}`
}

// 발사 순간을 now 대비 상대 날짜 라벨로(오늘/내일/MM-DD). 모두 예약 tz 기준으로 캘린더 일자를 비교.
// locale 은 호출부가 넘긴다(기본 ko) — format.ts 관례.
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
