import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Cancel a waiting scheduler queue entry (the work tab's kill switch) — BFF proxy; the control plane
// enforces runs:submit and the tenant guard (another workspace's entry reads 404).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    return NextResponse.json(await controlPlane.cancelQueueEntry(ctx, id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
