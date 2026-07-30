import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 토폴로지 헬스 로스터 BFF 프록시 — run 상세의 RunTopology 위젯이 폴링한다. 순수 토큰 쿠리어.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    return NextResponse.json(await controlPlane.getRunTopology(ctx, id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
