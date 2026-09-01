import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Live-trajectory BFF proxy — the run detail's LiveTrace widget polls it while the run executes.
// Workspace scoping/authz (incl. the run-audience rule) is enforced by the control plane; pure token courier.
//
// The widget's `?after=` cursor is FORWARDED. A courier that drops it turns an incremental read back into a
// full one without changing a single line on either side of it — the caller asks, the control plane can
// answer, and the middle silently makes both pointless.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  const raw = new URL(request.url).searchParams.get('after')
  const after = raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined
  try {
    return NextResponse.json(await controlPlane.getRunLiveTrace(ctx, id, after))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
