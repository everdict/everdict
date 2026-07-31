import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Soft-interrupt the session's live turn (ESC semantics): aborts only the in-flight step — with a message
// queued first (POST /input) the turn continues REDIRECTED; bare it ends "interrupted". A 404 (nothing
// interruptible) surfaces as-is; the panel falls back to a normal send.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    return NextResponse.json(await agentPlane.interruptTurn(ctx, id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
