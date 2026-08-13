import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { resolveClientWsBase } from '@/shared/lib/runner-api-url'

// Interactive browser-session WS ticket BFF (browser-profiles S1) — mints a short-lived single-use ticket at the
// control plane (owner-only, enforced there) and returns it plus the WS base the browser should connect to. The
// browser opens the WebSocket to the control plane directly (Next can't proxy a WS upgrade); the ticket is the auth.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  const wsBase = await resolveClientWsBase()
  try {
    const { ticket } = await controlPlane.browserSessionTicket<{ ticket: string }>(ctx, id)
    return NextResponse.json({
      ticket,
      wsUrl: `${wsBase}/browser-sessions/${encodeURIComponent(id)}`,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
