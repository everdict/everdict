import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Workspace models BFF proxy — the agent chat's per-conversation model picker lists the workspace's registered
// models (the same ids the agent server resolves to run the turn). On-demand so the panel only fetches it when
// a conversation is open. Failure → 502 envelope (the picker degrades to "workspace default").
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.listModels(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
