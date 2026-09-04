import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The work queue snapshot BFF proxy — polled by the infra panel widget (the web never calls the control plane directly, by rule).
// The runs:read scope is enforced by the control plane from the principal. A failure is passed on as a 502 envelope (the same shape as the notifications proxy).
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.getQueue(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
