import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 알림 읽음 처리 프록시 — {ids:[…]} 또는 {all:true}. 컨트롤플레인 POST /notifications/read 미러.
export async function POST(request: Request): Promise<Response> {
  const ctx = await authContext()
  const body: unknown = await request.json().catch(() => ({}))
  try {
    return NextResponse.json(await controlPlane.readNotifications(ctx, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
