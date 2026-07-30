import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Explicitly stop the session's live turn — the panel's Stop button (a client disconnect no longer aborts the
// loop server-side). A 404 (nothing live) is fine to surface as-is; the panel treats it as already settled.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    return NextResponse.json(await agentPlane.stopTurn(ctx, id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
