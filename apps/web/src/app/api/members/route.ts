import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 워크스페이스 멤버 BFF 프록시 — work-panel 드로어가 최초 오픈 시 lazy 로 불러 작성자 이름/아바타를 붙인다.
// 레이아웃(모든 페이지)에 멤버 조회를 얹지 않기 위한 온디맨드 경로. 실패는 502 봉투.
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.listMembers(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
