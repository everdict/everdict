import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 실행 피드 BFF 프록시 — infra-panel runs 탭이 폴링(웹은 컨트롤플레인을 직접 호출하지 않는 규칙).
// scope=all = 단독 run + 스코어카드 자식 run(라이브로 지켜볼 단위). 실패는 502 봉투(/api/queue 와 동일 형태).
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.listRuns(ctx, { all: true }))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
