import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Remove a workspace egress proxy (browser-profiles S4) — admin, enforced by the control plane.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { name } = await params
  try {
    await controlPlane.deleteProxy(ctx, name)
    return new NextResponse(null, { status: 204 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
