import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// Agent conversations BFF (docs/architecture/agent-conversations.md) — GET lists the caller's sessions, POST
// creates one. The agent server scopes to the caller's workspace via the forwarded bearer; failures → 502 envelope.
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await agentPlane.listSessions(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function POST(request: Request): Promise<Response> {
  const ctx = await authContext()
  try {
    const body = await request.json().catch(() => ({}))
    return NextResponse.json(await agentPlane.createSession(ctx, body))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
