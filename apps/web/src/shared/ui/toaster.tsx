'use client'

import { Toaster as SonnerToaster } from 'sonner'

// Linear st. toast (sonner) — styled with the app's design tokens (popover/border/foreground) so it responds to the .dark
// class toggle for light/dark automatically. Only the success icon (check) uses sonner's default; the background uses the app tone.
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={16}
      gap={8}
      toastOptions={{
        style: {
          background: 'var(--color-popover)',
          color: 'var(--color-popover-foreground)',
          border: '1px solid var(--color-border)',
          borderRadius: '0.6rem',
          fontSize: '13px',
          boxShadow: '0 10px 34px -8px rgba(0,0,0,0.28)',
        },
      }}
    />
  )
}
