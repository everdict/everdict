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

// Apply the theme before paint to prevent FOUC (theme flicker).
// Prefer the stored explicit choice (localStorage), else the OS preference (prefers-color-scheme).
const themeScript = `(function(){try{var s=localStorage.getItem('theme');var d=s?s==='dark':matchMedia('(prefers-color-scheme: dark)').matches;var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(_){}})();`

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Locale/catalog is resolved per request by shared/i18n/request.ts (cookie > Accept-Language > en).
  const locale = await getLocale()
  const messages = await getMessages()
  return (
    <html lang={locale} suppressHydrationWarning>
      {/* In the App Router a manual <head> conflicts with the head Next injects and causes a hydration
          mismatch → the whole app's interactivity can die. Placing this as an inline script at the top of body runs it
          before content paint, so it both prevents FOUC and stays hydration-safe (script↔script matching). */}
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
