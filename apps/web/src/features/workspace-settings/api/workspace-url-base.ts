import 'server-only'

import { headers } from 'next/headers'

import { env } from '@/shared/config/env'

// The workspace's canonical address shown read-only in Settings › General. Linear-style routing means a workspace
// lives at `<origin>/<workspace-id>`, so by default we derive the base from the ACTUAL request origin — a self-hosted
// deployment shows its own server address with zero config. An operator can pin a vanity/canonical domain (used
// verbatim, e.g. behind a proxy that rewrites the host) by setting WORKSPACE_URL_BASE.
export async function resolveWorkspaceUrlBase(): Promise<string> {
  const override = env.WORKSPACE_URL_BASE?.trim().replace(/\/+$/, '')
  if (override) return override
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  // host is always present on a real HTTP/1.1+ request; the fallback only guards a synthetic/no-header context.
  if (!host) return 'localhost'
  const proto = h.get('x-forwarded-proto') ?? 'http'
  return `${proto}://${host}`
}
