import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// The agent try-drive BFF (agent-automation B3) — the crafting canvas' "try" shadow-runs the draft.
export async function POST(request: Request): Promise<Response> {
  const ctx = await authContext()
  try {
    const body = await request.json().catch(() => ({}))
    return NextResponse.json(await agentPlane.tryAgent(ctx, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
