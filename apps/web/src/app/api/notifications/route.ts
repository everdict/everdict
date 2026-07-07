import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Notification-feed BFF proxy — the bell widget polls it (per the web rule that the client never hits the control plane directly).
// Personally-owned feed, so no role gate — the control plane scopes it by principal.subject.
export async function GET(request: Request): Promise<Response> {
  const ctx = await authContext()
  const url = new URL(request.url)
  const qs = url.search
  try {
    return NextResponse.json(await controlPlane.listNotifications(ctx, qs))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
