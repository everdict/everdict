import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 토폴로지 서비스 로그 테일 BFF 프록시 — RunTopology 위젯의 행별 로그 펼침이 호출한다. 순수 토큰 쿠리어.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; service: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id, service } = await params
  try {
    return NextResponse.json(await controlPlane.getTopologyServiceLogs(ctx, id, service))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
