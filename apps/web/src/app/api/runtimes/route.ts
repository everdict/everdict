import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 실행 인프라 로스터 BFF 프록시 — infra-panel runtimes 탭이 폴링. 워크스페이스 런타임 + 내 self-hosted 러너를
// 한 응답으로 합친다(각각 soft-fail: 한쪽 실패가 탭 전체를 비우지 않게). 웹은 컨트롤플레인을 직접 호출하지 않는 규칙.
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  const [runtimes, runners] = await Promise.all([
    controlPlane.listRuntimes<unknown[]>(ctx).catch(() => []),
    controlPlane
      .listRunners<{ runners: unknown[] }>(ctx)
      .then((r) => r.runners)
      .catch(() => []),
  ])
  return NextResponse.json({ runtimes, runners })
}
