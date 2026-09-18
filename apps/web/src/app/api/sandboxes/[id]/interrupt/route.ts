import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Abort the delegate's current TURN and keep the relationship: the container, the working directory and the
// conversation survive, and it takes the next instruction immediately. Distinct from `close`, which destroys
// all of it — which is why a supervisor who suspected a delegate was going the wrong way used to wait.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  // The reason is optional on the wire and asked for in the UI: "the turn was aborted" without one is a
  // record that explains nothing to whoever reads the trajectory afterwards.
  const body: unknown = await request.json().catch(() => ({}))
  const reason =
    typeof body === 'object' && body !== null && typeof (body as { reason?: unknown }).reason === 'string'
      ? (body as { reason: string }).reason
      : undefined
  try {
    return NextResponse.json(await controlPlane.interruptSandbox(ctx, id, reason))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
