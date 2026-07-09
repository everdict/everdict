import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { env } from '@/shared/config/env'
import { controlPlane } from '@/shared/lib/control-plane'

// Interactive-terminal ticket BFF (observability ⑥) — mints a short-lived ticket at the control plane (creator-or-
// admin, enforced there) and returns it plus the WS base the browser should connect to. The browser opens the
// WebSocket to the control plane directly (Next can't proxy a WS upgrade); the ticket is the auth.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  const wsBase = (env.CONTROL_PLANE_WS_URL ?? env.CONTROL_PLANE_URL.replace(/^http/, 'ws')).replace(
    /\/$/,
    ''
  )
  try {
    const { ticket } = await controlPlane.terminalTicket<{ ticket: string }>(ctx, id)
    return NextResponse.json({ ticket, wsUrl: `${wsBase}/runs/${encodeURIComponent(id)}/terminal` })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
