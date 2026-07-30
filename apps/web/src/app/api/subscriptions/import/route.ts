import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Trigger relocation (E3's last rung): agent-spec triggers → subscriptions, spec copies cleared.
export async function POST(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.importAgentTriggers(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
