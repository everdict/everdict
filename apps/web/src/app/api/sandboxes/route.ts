import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Sandbox sessions BFF proxy — the harness playground's boot + reattach surface (the panel never hits the control
// plane directly). Both verbs mirror the UPSTREAM STATUS instead of flattening failures to 502: a 404 here means
// this deployment composed no sandbox driver, which the panel renders as a friendly "not configured" callout, and
// 402/429 carry cap messages the member can act on. Only a transport failure is ours (502).

export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    const res = await controlPlane.listSandboxes(ctx)
    return NextResponse.json(res.body, { status: res.status })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function POST(request: Request): Promise<Response> {
  const ctx = await authContext()
  try {
    const body: unknown = await request.json()
    const res = await controlPlane.createSandbox(ctx, body)
    return NextResponse.json(res.body, { status: res.status })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
