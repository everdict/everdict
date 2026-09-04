import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The multiplexed live SSE proxy (④) — it streams the control plane's /runs/:id/live/stream through UNBUFFERED, verbatim
// (the same pattern as the agent session stream proxy). The per-widget polling remains as the fallback for when this stream cannot attach.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  const lanes = new URL(request.url).searchParams.get('lanes') ?? 'trace'
  try {
    const upstream = await controlPlane.streamRunLive(ctx, id, lanes)
    if (!upstream.ok || upstream.body === null) {
      return NextResponse.json({ error: `control plane ${upstream.status}` }, { status: upstream.status })
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
      },
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
