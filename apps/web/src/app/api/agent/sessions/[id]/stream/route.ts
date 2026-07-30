import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Re-attach to the session's LIVE turn (the panel switched conversations and came back — the turn kept running
// on the agent server). Proxies the agent's SSE straight through (unbuffered), like the chat route; 204 means
// nothing is live and the panel stays idle.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const upstream = await agentPlane.streamRaw(ctx, id)
    if (upstream.status === 204) return new Response(null, { status: 204 })
    if (upstream.body === null) {
      return NextResponse.json({ error: `agent ${upstream.status}` }, { status: 502 })
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-cache, no-transform',
      },
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
