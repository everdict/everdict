import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Fleet BFF (docs/architecture/agent-automation.md A5) — the workspace's agent runs, newest first. The client
// island polls this for live status; the agent server scopes to the caller's workspace via the forwarded bearer.
export async function GET(request: Request): Promise<Response> {
  const ctx = await authContext()
  const limit = new URL(request.url).searchParams.get('limit')
  try {
    return NextResponse.json(await agentPlane.listRuns(ctx, limit ? Number(limit) : undefined))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
