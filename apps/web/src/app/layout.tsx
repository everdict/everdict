import type { Metadata } from 'next'

import { QueryProvider } from '@/shared/providers/query-provider'

import './globals.css'

export const metadata: Metadata = {
  title: 'Assay',
  description: 'Harness-agnostic agent evaluation runtime — multi-tenant control plane',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  )
}
