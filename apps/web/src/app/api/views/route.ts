import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The caller's visible saved Views (workspace-shared + own private) — powers client-side pickers
// (e.g. pinning a conversation artifact onto a View). AuthZ is the control plane's (scorecards:read).
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.listViews(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
