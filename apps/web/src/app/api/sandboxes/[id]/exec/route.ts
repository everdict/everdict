import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// One-shot command inside a live session's container — the playground's shell disclosure. A non-zero exit is a
// RESULT, not an error: it comes back 200 with the exit code, and only a transport/upstream failure is a 502.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const body: unknown = await request.json()
    return NextResponse.json(await controlPlane.execInSandbox(ctx, id, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
