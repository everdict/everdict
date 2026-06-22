import type { Metadata } from 'next'

import { QueryProvider } from '@/shared/providers/query-provider'

import './globals.css'

export const metadata: Metadata = {
  title: 'Assay',
  description: 'Harness-agnostic agent evaluation runtime — multi-tenant control plane',
}

// 페인트 전에 테마를 적용해 FOUC(테마 깜빡임)를 막는다.
// 저장된 명시적 선택(localStorage) 우선, 없으면 OS 선호도(prefers-color-scheme).
const themeScript = `(function(){try{var s=localStorage.getItem('theme');var d=s?s==='dark':matchMedia('(prefers-color-scheme: dark)').matches;var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(_){}})();`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  )
}
