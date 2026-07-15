import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 작업 큐 스냅샷 BFF 프록시 — work-panel 위젯이 폴링(웹은 컨트롤플레인을 직접 호출하지 않는 규칙).
// runs:read 스코프는 컨트롤플레인이 principal 로 강제한다. 실패는 502 봉투로 넘긴다(notifications 프록시와 동일 형태).
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.getQueue(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
