'use client'

import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'

import { AppShell } from './app-shell'
import { EmbedShell } from './embed-shell'

// Chrome vs chrome-less decider — a CLIENT component on purpose. The [workspace] layout is dynamic (headers()),
// so soft navigation re-renders it server-side WITHOUT the iframe signals (an RSC fetch has no
// sec-fetch-dest=iframe and no ?embed=1), which would resurrect the app chrome inside the infra panel's iframe.
// This client instance survives those RSC re-renders, so the framed decision is STICKY: once a document is known
// to be inside an iframe (server hint on the initial load, or the window.self check as the runtime authority),
// it stays chrome-less for its whole lifetime.
export function ShellSwitch({
  embedHint,
  children,
  ...appShellProps
}: Omit<ComponentProps<typeof AppShell>, 'children'> & {
  embedHint: boolean
  children: ReactNode
}) {
  const [framed, setFramed] = useState(embedHint)
  useEffect(() => {
    // Fallback for a full reload inside the iframe that lost ?embed=1 (plain-HTTP origins don't send
    // Sec-Fetch-Dest): detect the frame directly. Brief chrome flash, then bare — never the other way.
    if (window.self !== window.top) setFramed(true)
  }, [])
  if (framed) return <EmbedShell>{children}</EmbedShell>
  return <AppShell {...appShellProps}>{children}</AppShell>
}
