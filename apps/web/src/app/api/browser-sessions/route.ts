import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Interactive browser sessions BFF (browser-profiles S1) — personal / self-scoped (the control plane enforces
// owner-only). POST starts a dedicated browser; GET lists the caller's sessions. The client drives the browser over
// a WebSocket opened directly to the control plane (Next can't proxy a WS upgrade); the ticket is the auth.
export async function POST(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.createBrowserSession(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.listBrowserSessions(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
