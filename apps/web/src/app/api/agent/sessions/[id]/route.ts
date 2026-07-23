import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    return NextResponse.json(await agentPlane.getSession(ctx, id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const body = await request.json().catch(() => ({}))
    // Forward a partial patch: title (rename) and/or model (a registered model id pins the conversation's model;
    // null clears it → workspace/server default). The agent server validates that at least one is present.
    const patch: { title?: string; model?: string | null } = {}
    if (typeof body.title === 'string') patch.title = body.title
    if (typeof body.model === 'string' || body.model === null) patch.model = body.model
    return NextResponse.json(await agentPlane.updateSession(ctx, id, patch))
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
    await agentPlane.deleteSession(ctx, id)
    return new NextResponse(null, { status: 204 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
