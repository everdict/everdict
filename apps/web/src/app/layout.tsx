import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'

import { QueryProvider } from '@/shared/providers/query-provider'
import { Toaster } from '@/shared/ui/toaster'

import './globals.css'

export const metadata: Metadata = {
  title: 'Everdict',
  description: 'Harness-agnostic agent evaluation runtime — multi-tenant control plane',
}

// 페인트 전에 테마를 적용해 FOUC(테마 깜빡임)를 막는다.
// 저장된 명시적 선택(localStorage) 우선, 없으면 OS 선호도(prefers-color-scheme).
const themeScript = `(function(){try{var s=localStorage.getItem('theme');var d=s?s==='dark':matchMedia('(prefers-color-scheme: dark)').matches;var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(_){}})();`

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // 로케일/카탈로그는 shared/i18n/request.ts 가 요청마다 해석(쿠키 > Accept-Language > en).
  const locale = await getLocale()
  const messages = await getMessages()
  return (
    <html lang={locale} suppressHydrationWarning>
      {/* App Router 에서 수동 <head> 는 Next 가 주입하는 head 와 충돌해 hydration 미스매치를
          유발 → 앱 전체 인터랙션이 죽을 수 있다. body 최상단 인라인 스크립트로 두면 콘텐츠
          페인트 전에 실행돼 FOUC 도 막고 hydration 도 안전하다(script↔script 매칭). */}
      <body className="min-h-screen bg-background text-foreground antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <NextIntlClientProvider messages={messages}>
          <QueryProvider>{children}</QueryProvider>
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
