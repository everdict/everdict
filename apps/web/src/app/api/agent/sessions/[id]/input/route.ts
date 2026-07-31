import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Queue a user message into the session's RUNNING turn (mid-run steering): the loop absorbs it at the next
// boundary — or immediately when the composer follows up with POST /interrupt (queue-then-interrupt redirect).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const body = (await request.json().catch(() => ({}))) as { message?: unknown }
    if (typeof body.message !== 'string' || body.message.length === 0) {
      return NextResponse.json({ error: 'message required' }, { status: 400 })
    }
    return NextResponse.json(await agentPlane.queueInput(ctx, id, body.message))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
