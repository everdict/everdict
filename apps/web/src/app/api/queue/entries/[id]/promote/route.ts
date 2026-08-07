import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Move a waiting scheduler queue entry to the front of the effective order ("run this next") — BFF proxy;
// the control plane enforces runs:submit and the tenant guard.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    return NextResponse.json(await controlPlane.promoteQueueEntry(ctx, id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
