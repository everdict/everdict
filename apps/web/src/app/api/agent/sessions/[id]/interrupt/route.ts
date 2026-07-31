import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Soft-interrupt the session's live turn (ESC semantics): aborts only the in-flight step. With `message` the
// server queues it ATOMICALLY (liveness first — a redirect racing a finishing turn queues nothing and 404s,
// which the panel maps to "restore the input, ask to resend") and the turn continues REDIRECTED; bare it ends
// "interrupted".
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const body = (await request.json().catch(() => ({}))) as { message?: unknown }
    const message =
      typeof body.message === 'string' && body.message.length > 0 ? body.message : undefined
    return NextResponse.json(await agentPlane.interruptTurn(ctx, id, message))
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    // The agent plane's 404 (nothing interruptible) must reach the panel as 404 — it triggers the fallback.
    const status = /404|NOT_FOUND|not found/i.test(detail) ? 404 : 502
    return NextResponse.json({ error: detail }, { status })
  }
}
