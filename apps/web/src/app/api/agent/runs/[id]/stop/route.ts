import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Stop a live headless agent run (fleet control) — aborts its loop; the run settles as cancelled.
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const auth = await authContext()
  const { id } = await ctx.params
  try {
    return NextResponse.json(await agentPlane.stopRun(auth, id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
