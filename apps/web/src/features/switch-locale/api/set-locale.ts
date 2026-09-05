'use server'

import { cookies } from 'next/headers'

import { isLocale, LOCALE_COOKIE } from '@/shared/i18n/config'

// Store the locale cookie — an explicit choice takes precedence over Accept-Language detection (shared/i18n/request.ts).
// A server component's strings are redrawn by the caller's (the locale-switcher's) `refresh()`.

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the DECLARATION
// alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return
  const store = await cookies()
  store.set(LOCALE_COOKIE, locale, { maxAge: 60 * 60 * 24 * 365, path: '/', sameSite: 'lax' })
}
