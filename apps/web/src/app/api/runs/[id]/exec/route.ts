import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Sandbox-exec BFF proxy — the SandboxTerminal widget POSTs here (the client never hits the control plane
// directly). Creator-or-admin + workspace scoping are enforced by the control plane.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  try {
    return NextResponse.json(await controlPlane.execInRun(ctx, id, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
