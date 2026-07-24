import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Stop a teammate — unregister it (no more wakes) + revoke its execution token. The transcript is kept. Owner-scoped.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    await agentPlane.stopTeammate(ctx, id)
    return new NextResponse(null, { status: 204 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
