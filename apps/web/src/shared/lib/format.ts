// 대시보드 공통 포맷 — 점수/시각/건강도 표기를 한 곳으로(페이지마다 제각각이던 것을 통일).

export function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`
}

// 점수 = passRate 우선(%), 없으면 mean(2f), 둘 다 없으면 '–'. 리스트/리더보드/트렌드/상세 공통.
export function fmtScore(
  passRate: number | null | undefined,
  mean: number | null | undefined
): string {
  if (passRate != null) return fmtPct(passRate)
  if (mean != null) return mean.toFixed(2)
  return '–'
}

// 통과율 건강도 — 색 인코딩용. passRate(0~1)에만 의미(수치 메트릭은 'none'=중립).
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

// 컴팩트 시각 'MM-DD HH:mm'(값은 UTC 기준 — 정밀/로컬은 title 로 보완). ISO 가 아니면 그대로.
export function fmtDateTime(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso
  return iso
    .replace('T', ' ')
    .replace(/\.\d+Z?$/, '')
    .slice(5, 16)
}
// title= 용 로컬 풀 표기(hover 시 정확한 시각).
export function fmtDateTimeFull(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

// opaque subject(예: Keycloak sub)는 사람이 못 읽으니 축약 표기. 가능하면 members 조인 이름으로 대체하고,
// 이름이 없을 때의 폴백으로만 쓴다(만든이/생성자 표기 공통).
export function fmtSubject(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s
}

// 상대 시각(알림 등 피드용) — Intl.RelativeTimeFormat 로케일 표기('3분 전'/'3 minutes ago'),
// 7일 넘으면 절대 날짜로. locale 은 호출부(컴포넌트)가 useLocale()/getLocale() 로 넘긴다(기본 ko).
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

// 리스트 날짜 그룹 헤더 — 오늘/어제는 상대 표기(numeric:auto), 그 외 로케일 월·일(다른 해면 연도 포함).
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

// 날짜 그룹 행의 시각 — HH:MM(로컬). 날짜는 그룹 헤더가 갖는다.
export function fmtTimeOnly(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 날짜 그룹 키(로컬 자정 기준) — 같은 날이면 같은 키.
export function dayKeyOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
