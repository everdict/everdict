import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// A task's live trace page — the playground's 2s poll target. ?since= is the caller's cursor into the
// append-only buffer; omitted/0 = full replay (how a remounted panel reconstructs a task's feed).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id, taskId } = await params
  const raw = new URL(request.url).searchParams.get('since')
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  const since = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  try {
    return NextResponse.json(await controlPlane.readSandboxTaskTrace(ctx, id, taskId, since))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
