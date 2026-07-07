'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'

import { isLocale, LOCALE_COOKIE } from '@/shared/i18n/config'

// 로케일 쿠키 저장 — 명시 선택은 Accept-Language 감지보다 우선한다(shared/i18n/request.ts).
// 레이아웃 전체 재검증으로 서버 컴포넌트 문자열까지 즉시 갱신.
export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return
  const store = await cookies()
  store.set(LOCALE_COOKIE, locale, { maxAge: 60 * 60 * 24 * 365, path: '/', sameSite: 'lax' })
  revalidatePath('/', 'layout')
}
