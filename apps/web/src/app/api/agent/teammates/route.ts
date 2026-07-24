import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Teammates BFF (docs/architecture/agent-teams.md) — GET lists the caller's live teammates, POST spawns one
// { name, task, watch[] }. The agent server scopes to the caller via the forwarded bearer; failures → 502 envelope.
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await agentPlane.listTeammates(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function POST(request: Request): Promise<Response> {
  const ctx = await authContext()
  try {
    const body = await request.json().catch(() => ({}))
    return NextResponse.json(await agentPlane.spawnTeammate(ctx, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
