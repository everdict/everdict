import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Warm re-login BFF (browser-profiles) — POST { sessionId } → the control plane seeds the profile's saved cookies
// into the live session so re-logging in starts from the prior state. Returns the domains the profile carries;
// cookie values never cross the wire. Owner-only, enforced by the control plane.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const body = await request.json()
    return NextResponse.json(await controlPlane.restoreBrowserProfile(ctx, id, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
