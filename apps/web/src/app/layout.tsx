import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'

import { DesktopTitlebar } from '@/widgets/desktop-titlebar'
import { TimezoneAutoInit } from '@/features/switch-timezone'
import { QueryProvider } from '@/shared/providers/query-provider'
import { Toaster } from '@/shared/ui/toaster'

import './globals.css'

export const metadata: Metadata = {
  title: 'Everdict',
  description: 'Harness-agnostic agent evaluation runtime — multi-tenant control plane',
}

// Apply the theme before paint to prevent FOUC (theme flicker).
// When framed (the infra panel hosts pages in a same-origin iframe), the PARENT is the authority: adopt its
// resolved theme class directly, so the panel can never disagree with the app around it (both sides otherwise
// compute prefers-color-scheme independently, which races on first paint). Otherwise prefer the stored explicit
// choice (localStorage), else the OS preference.
// It also re-applies on the `storage` event so a theme change in another same-origin document takes effect
// here without a reload — the mounted iframe stays alive, so a toggle in the parent must sync into it (the storage
// event fires in every OTHER same-origin document; the parent's class is already updated by then); cross-tab too.
const themeScript = `(function(){function a(){try{var e=document.documentElement;var d;if(window.self!==window.top){try{d=parent.document.documentElement.classList.contains('dark');}catch(_){}}if(d===undefined){var s=localStorage.getItem('theme');d=s?s==='dark':matchMedia('(prefers-color-scheme: dark)').matches;}e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(_){}}a();try{window.addEventListener('storage',function(ev){if(!ev.key||ev.key==='theme')a();});}catch(_){}})();`

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
          {/* First-visit only: seed the display timezone from the browser's zone if the user hasn't chosen one. */}
          <TimezoneAutoInit />
          {/* Custom frameless title bar — renders only inside the desktop shell (desktop D10); nothing in a browser. */}
          <DesktopTitlebar />
          <QueryProvider>{children}</QueryProvider>
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
