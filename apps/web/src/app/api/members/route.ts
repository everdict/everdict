import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The workspace members BFF proxy — the infra panel loads it lazily on first open to attach author names and avatars.
// An on-demand path, so a member lookup is not laid on the layout (i.e. on every page). A failure comes back as a 502 envelope.
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.listMembers(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
