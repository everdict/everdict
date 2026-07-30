import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Submit one ad-hoc test case into a live harness session → 202 with the child run. The upstream status is
// mirrored because the panel acts on it: 409 = another task is still running (restore the composer input rather
// than losing the member's prompt), 402 = budget, 404 = the session is gone.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const body: unknown = await request.json()
    const res = await controlPlane.submitSandboxTask(ctx, id, body)
    return NextResponse.json(res.body, { status: res.status })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
