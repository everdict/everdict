import 'server-only'

import { headers } from 'next/headers'

import { env } from '@/shared/config/env'

// Loopback hosts a server-side TEMPORAL_UI_URL may carry (the compose default `http://localhost:8233`) —
// reachable from the server itself, but not from a user's browser on another machine.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

// Temporal Web UI base for browser-facing deep links (the scorecard workflow chip). TEMPORAL_UI_URL is
// server-side config, but the href it feeds is opened by the BROWSER — so a loopback host is rebased onto
// the actual request host (configured port/path kept): the compose stack publishes the Temporal UI on the
// same host as the web, which makes the zero-config default correct for remote users (same idiom as
// resolveWorkspaceUrlBase). A non-loopback value is used verbatim (vanity domain / reverse proxy); unset
// means no Temporal UI is exposed and callers render no link.
export async function resolveTemporalUiBase(): Promise<string | undefined> {
  if (!env.TEMPORAL_UI_URL) return undefined
  const base = new URL(env.TEMPORAL_UI_URL)
  if (LOOPBACK_HOSTNAMES.has(base.hostname)) {
    const h = await headers()
    const requestHost = h.get('x-forwarded-host') ?? h.get('host')
    if (requestHost) base.hostname = new URL(`http://${requestHost}`).hostname
  }
  return base.toString().replace(/\/+$/, '')
}
