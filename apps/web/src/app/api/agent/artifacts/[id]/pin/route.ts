import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Pin/unpin a conversation artifact onto a View — creator-only; the agent service re-verifies the target
// View's visibility with the forwarded bearer.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const body = (await request.json().catch(() => ({}))) as { viewId?: unknown }
    if (typeof body.viewId !== 'string' || body.viewId.length === 0)
      return NextResponse.json({ error: 'viewId is required' }, { status: 400 })
    return NextResponse.json(await agentPlane.pinArtifact(ctx, id, body.viewId))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    await agentPlane.unpinArtifact(ctx, id)
    return new Response(null, { status: 204 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
