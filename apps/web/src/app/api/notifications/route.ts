import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 알림 피드 BFF 프록시 — 벨 위젯이 폴링한다(클라이언트는 컨트롤플레인을 직접 치지 않는다는 웹 룰).
// 개인 소유 피드라 역할 게이트 없음 — 컨트롤플레인이 principal.subject 로 스코프한다.
export async function GET(request: Request): Promise<Response> {
  const ctx = await authContext()
  const url = new URL(request.url)
  const qs = url.search
  try {
    return NextResponse.json(await controlPlane.listNotifications(ctx, qs))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

