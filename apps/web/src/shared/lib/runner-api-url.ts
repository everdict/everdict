import 'server-only'

import { headers } from 'next/headers'

import { env } from '@/shared/config/env'

// Loopback hosts a server-side CONTROL_PLANE_URL commonly carries (the compose/dev default `http://127.0.0.1:8787`) —
// reachable from the web server itself, but NOT from a self-hosted runner on another machine.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

// The control-plane base URL a self-hosted RUNNER should dial (it connects to `<base>/mcp` DIRECTLY, not through the
// web). CONTROL_PLANE_URL is the web server's url to reach the CP — often a loopback that a runner on another machine
// can't reach (the #1 "runner won't connect" cause). So: an explicit CONTROL_PLANE_PUBLIC_URL wins verbatim (vanity /
// reverse-proxy origin); otherwise a loopback CONTROL_PLANE_URL is rebased onto the actual request host (keeping the
// CP's configured port/path), which makes the zero-config default correct when the CP is published on the same host as
// the web (the common single-host deploy) — the same idiom as resolveTemporalUiBase / the terminal WS url.
export async function resolveRunnerApiUrl(): Promise<string> {
  if (env.CONTROL_PLANE_PUBLIC_URL) return env.CONTROL_PLANE_PUBLIC_URL.replace(/\/+$/, '')
  const base = new URL(env.CONTROL_PLANE_URL)
  if (LOOPBACK_HOSTNAMES.has(base.hostname)) {
    const h = await headers()
    const requestHost = h.get('x-forwarded-host') ?? h.get('host')
    // Rebase only the host; keep the CP's port/path. The request host may carry the WEB's port (e.g. :3000) — the CP
    // port stays whatever CONTROL_PLANE_URL declared (e.g. :8787), so `<request-hostname>:<cp-port>` is dialed.
    if (requestHost) base.hostname = new URL(`http://${requestHost}`).hostname
  }
  return base.toString().replace(/\/+$/, '')
}
