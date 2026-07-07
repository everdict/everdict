'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'

import { isLocale, LOCALE_COOKIE } from '@/shared/i18n/config'

// Store the locale cookie — an explicit choice takes precedence over Accept-Language detection (shared/i18n/request.ts).
// Full-layout revalidation refreshes server component strings immediately too.
export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return
  const store = await cookies()
  store.set(LOCALE_COOKIE, locale, { maxAge: 60 * 60 * 24 * 365, path: '/', sameSite: 'lax' })
  revalidatePath('/', 'layout')
}
