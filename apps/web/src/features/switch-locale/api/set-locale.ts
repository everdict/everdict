'use server'

import { cookies } from 'next/headers'

import { isLocale, LOCALE_COOKIE } from '@/shared/i18n/config'

// Store the locale cookie — an explicit choice takes precedence over Accept-Language detection (shared/i18n/request.ts).
// 서버 컴포넌트의 문자열은 부른 쪽(locale-switcher)의 `refresh()` 가 다시 그린다.

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return
  const store = await cookies()
  store.set(LOCALE_COOKIE, locale, { maxAge: 60 * 60 * 24 * 365, path: '/', sameSite: 'lax' })
}
