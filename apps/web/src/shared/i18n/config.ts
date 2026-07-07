// Locale constants — imported from both client and server, so no server-only (same pattern as the workspace-scope constants).
export const LOCALES = ['ko', 'en'] as const
export type Locale = (typeof LOCALES)[number]

// When there is no explicit choice (cookie), detect from Accept-Language; failing that, en (public repo default).
export const FALLBACK_LOCALE: Locale = 'en'
export const LOCALE_COOKIE = 'everdict-locale'

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (LOCALES as readonly string[]).includes(value)
}
