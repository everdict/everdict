import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { resolveClientWsBase } from '@/shared/lib/runner-api-url'

// Interactive run-screen ticket BFF (observability ⑦b) — taking over the browser a case is driving, to get it past
// a login wall or a captcha. Same shape as the terminal ticket: the control plane mints it (creator-or-admin,
// enforced there) and the browser opens the WebSocket to the control plane directly, because Next cannot proxy a
// WS upgrade and a browser cannot put an Authorization header on one.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  const wsBase = await resolveClientWsBase()
  try {
    const { ticket } = await controlPlane.runScreenTicket<{ ticket: string }>(ctx, id)
    return NextResponse.json({ ticket, wsUrl: `${wsBase}/runs/${encodeURIComponent(id)}/screen` })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
