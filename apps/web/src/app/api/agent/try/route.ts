import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// 에이전트 try-drive BFF(agent-automation B3) — 크래프팅 캔버스의 "try"가 draft 를 섀도 실행한다.
export async function POST(request: Request): Promise<Response> {
  const ctx = await authContext()
  try {
    const body = await request.json().catch(() => ({}))
    return NextResponse.json(await agentPlane.tryAgent(ctx, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
