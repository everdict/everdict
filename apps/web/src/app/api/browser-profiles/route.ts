import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Saved browser profiles BFF (browser-profiles S2) — personal / self-scoped (the control plane enforces owner-only).
// POST creates a profile; GET lists the caller's profiles.
export async function POST(request: Request): Promise<Response> {
  const ctx = await authContext()
  try {
    const body = await request.json()
    return NextResponse.json(await controlPlane.createBrowserProfile(ctx, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.listBrowserProfiles(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
