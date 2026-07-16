import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Capture a session login into a profile BFF (browser-profiles S3) — POST { sessionId } → the control plane reads
// the session's cookies and stores them (encrypted) on the profile. Owner-only, enforced by the control plane.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const body = await request.json()
    return NextResponse.json(await controlPlane.captureBrowserProfile(ctx, id, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
