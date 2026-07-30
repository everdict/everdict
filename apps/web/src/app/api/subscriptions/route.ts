import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Subscriptions BFF (E3 registry) — the manager's mutation path; the control plane enforces
// agents:write + creator-or-admin.
export async function POST(request: Request): Promise<Response> {
  const ctx = await authContext()
  try {
    const body = await request.json()
    return NextResponse.json(await controlPlane.createSubscription(ctx, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.listSubscriptions(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
