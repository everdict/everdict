import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Workspace egress proxies BFF (browser-profiles S4) — GET lists the per-country proxies (secrets redacted; the
// session geo picker uses it); PUT registers/updates one (admin, enforced by the control plane).
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.listProxies(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function PUT(request: Request): Promise<Response> {
  const ctx = await authContext()
  try {
    const body = await request.json()
    return NextResponse.json(await controlPlane.upsertProxy(ctx, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
