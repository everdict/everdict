import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 플랫폼 이벤트 로그 BFF(agent-automation A1) — 크래프팅 스튜디오의 리플레이 피커가 최근 사실을 고른다.
export async function GET(request: Request): Promise<Response> {
  const ctx = await authContext()
  const limit = new URL(request.url).searchParams.get('limit')
  try {
    return NextResponse.json(
      await controlPlane.listPlatformEvents(ctx, limit ? Number(limit) : undefined)
    )
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
