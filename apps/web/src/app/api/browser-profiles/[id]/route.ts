import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Saved browser profile BFF (browser-profiles S2) — PATCH renames / updates cookie domains, DELETE removes it.
// Owner-only, enforced by the control plane.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const body = await request.json()
    return NextResponse.json(await controlPlane.updateBrowserProfile(ctx, id, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    await controlPlane.deleteBrowserProfile(ctx, id)
    return new NextResponse(null, { status: 204 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
