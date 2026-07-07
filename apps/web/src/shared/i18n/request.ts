import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'

import { FALLBACK_LOCALE, isLocale, LOCALE_COOKIE, LOCALES, type Locale } from './config'

// Accept-Language 에서 지원 로케일을 감지(q 값 순서는 브라우저가 이미 정렬해 보냄 — 앞에서부터 매칭).
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

// 요청 로케일: 쿠키(명시 선택, features/switch-locale) > Accept-Language > en.
// URL 라우팅은 쓰지 않는다 — /{workspace}/* 스킴(Linear 식)에 로케일 세그먼트를 끼워 넣지 않는다.
export default getRequestConfig(async () => {
  const store = await cookies()
  const fromCookie = store.get(LOCALE_COOKIE)?.value
  const locale = isLocale(fromCookie)
    ? fromCookie
    : detectLocale((await headers()).get('accept-language'))
  return { locale, messages: (await import(`../../../messages/${locale}.json`)).default }
})
