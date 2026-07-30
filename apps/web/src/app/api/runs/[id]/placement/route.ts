import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 케이스 배치 조회 BFF 프록시 — run 상세의 RunPlacement 위젯이 폴링한다(클라이언트는 컨트롤플레인 직접 호출 금지).
// 워크스페이스 스코핑/authz는 컨트롤플레인이 강제하는 순수 토큰 쿠리어.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    return NextResponse.json(await controlPlane.getRunPlacement(ctx, id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
