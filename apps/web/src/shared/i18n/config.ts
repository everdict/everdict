// 로케일 상수 — 클라이언트/서버 양쪽에서 임포트되므로 server-only 금지(워크스페이스-스코프 상수와 동일 패턴).
export const LOCALES = ['ko', 'en'] as const
export type Locale = (typeof LOCALES)[number]

// 명시 선택(쿠키)이 없을 때 Accept-Language 로 감지하고, 그마저 없으면 en(공개 리포 기본).
export const FALLBACK_LOCALE: Locale = 'en'
export const LOCALE_COOKIE = 'everdict-locale'

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (LOCALES as readonly string[]).includes(value)
}
