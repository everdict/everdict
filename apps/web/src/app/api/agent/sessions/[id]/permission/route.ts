import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// HITL: forward the human's allow/deny decision for a write-tool approval the streaming turn is awaiting.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const body = await request.json().catch(() => ({}))
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    const decision = body.decision === 'allow' ? 'allow' : 'deny'
    return NextResponse.json(await agentPlane.respondPermission(ctx, id, requestId, decision))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
