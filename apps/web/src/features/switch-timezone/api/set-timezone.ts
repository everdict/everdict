'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'

import { isValidTimeZone, TIMEZONE_COOKIE } from '@/shared/i18n/timezone'

// Store the timezone cookie — an explicit choice the app then renders every timestamp in (shared/i18n/request.ts
// feeds it to next-intl's timeZone). Full-layout revalidation re-renders server component dates immediately.
export async function setTimezone(timeZone: string): Promise<void> {
  if (!isValidTimeZone(timeZone)) return
  const store = await cookies()
  store.set(TIMEZONE_COOKIE, timeZone, { maxAge: 60 * 60 * 24 * 365, path: '/', sameSite: 'lax' })
  revalidatePath('/', 'layout')
}
