import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 멀티플렉스 라이브 SSE 프록시(④) — 컨트롤 플레인의 /runs/:id/live/stream 을 무버퍼로 그대로 흘린다
// (agent 세션 stream 프록시와 같은 패턴). 위젯별 폴링은 이 스트림이 붙지 못할 때의 폴백으로 남는다.
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
