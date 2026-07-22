import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'

import { FALLBACK_LOCALE, isLocale, LOCALE_COOKIE, LOCALES, type Locale } from './config'
import { DEFAULT_TIMEZONE, isValidTimeZone, TIMEZONE_COOKIE } from './timezone'

// Detect a supported locale from Accept-Language (the browser already sends q-values in order — match from the front).
function detectLocale(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) return FALLBACK_LOCALE
  for (const part of acceptLanguage.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase() ?? ''
    const base = tag.split('-')[0]
    const hit = LOCALES.find((l) => l === base)
    if (hit) return hit
  }
  return FALLBACK_LOCALE
}

// Request locale: cookie (explicit choice, features/switch-locale) > Accept-Language > en.
// No URL routing — don't splice a locale segment into the /{workspace}/* scheme (Linear-style).
export default getRequestConfig(async () => {
  const store = await cookies()
  const fromCookie = store.get(LOCALE_COOKIE)?.value
  const locale = isLocale(fromCookie)
    ? fromCookie
    : detectLocale((await headers()).get('accept-language'))
  // Display timezone: cookie (explicit choice, features/switch-timezone) > UTC default. Exposed to the app via
  // next-intl's useTimeZone()/getTimeZone(), which the format atoms consume so server + client render the same zone.
  const tzCookie = store.get(TIMEZONE_COOKIE)?.value
  const timeZone = isValidTimeZone(tzCookie) ? tzCookie : DEFAULT_TIMEZONE
  return { locale, timeZone, messages: (await import(`../../../messages/${locale}.json`)).default }
})
