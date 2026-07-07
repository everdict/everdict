import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'

import { FALLBACK_LOCALE, isLocale, LOCALE_COOKIE, LOCALES, type Locale } from './config'

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
  return { locale, messages: (await import(`../../../messages/${locale}.json`)).default }
})
