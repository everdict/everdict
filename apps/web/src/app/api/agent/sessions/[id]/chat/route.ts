import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Send a user message and run one agent turn. The web requests text/event-stream, so this proxies the agent's SSE
// straight through (unbuffered) — token deltas + persisted message records arrive live. A non-stream request falls
// back to the buffered JSON tail.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  const accept = request.headers.get('accept') ?? ''
  try {
    const body = await request.json().catch(() => ({}))
    const upstream = await agentPlane.chatRaw(ctx, id, body, accept)
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
