import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The platform event log BFF (agent-automation A1) — the crafting studio's replay picker chooses a recent fact from it.
export async function GET(request: Request): Promise<Response> {
  const ctx = await authContext()
  const limit = new URL(request.url).searchParams.get('limit')
  try {
    return NextResponse.json(
      await controlPlane.listPlatformEvents(ctx, limit ? Number(limit) : undefined)
    )
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
