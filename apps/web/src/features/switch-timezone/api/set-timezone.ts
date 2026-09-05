'use server'

import { cookies } from 'next/headers'

import { isValidTimeZone, TIMEZONE_COOKIE } from '@/shared/i18n/timezone'

// Store the timezone cookie — an explicit choice the app then renders every timestamp in (shared/i18n/request.ts
// feeds it to next-intl's timeZone). A server component's dates are redrawn by the caller's `refresh()`.

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the DECLARATION
// alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export async function setTimezone(timeZone: string): Promise<void> {
  if (!isValidTimeZone(timeZone)) return
  const store = await cookies()
  store.set(TIMEZONE_COOKIE, timeZone, { maxAge: 60 * 60 * 24 * 365, path: '/', sameSite: 'lax' })
}
