import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'

// The session transcript, oldest first. ?since=<seq> returns only newer messages (incremental polling).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  const sinceRaw = new URL(request.url).searchParams.get('since')
  const since = sinceRaw !== null && sinceRaw !== '' ? Number(sinceRaw) : undefined
  try {
    return NextResponse.json(
      await agentPlane.listMessages(
        ctx,
        id,
        since !== undefined && Number.isFinite(since) ? since : undefined
      )
    )
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
