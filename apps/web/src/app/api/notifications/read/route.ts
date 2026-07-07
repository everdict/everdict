import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Mark-notifications-read proxy — {ids:[…]} or {all:true}. Mirrors the control-plane POST /notifications/read.
export async function POST(request: Request): Promise<Response> {
  const ctx = await authContext()
  const body: unknown = await request.json().catch(() => ({}))
  try {
    return NextResponse.json(await controlPlane.readNotifications(ctx, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
