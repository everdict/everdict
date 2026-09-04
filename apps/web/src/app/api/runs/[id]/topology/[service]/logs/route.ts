import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The topology service log tail BFF proxy — called by the RunTopology widget's per-row log expansion. A pure token courier.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; service: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id, service } = await params
  try {
    return NextResponse.json(await controlPlane.getTopologyServiceLogs(ctx, id, service))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
