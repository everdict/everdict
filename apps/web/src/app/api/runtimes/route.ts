import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Registered runtimes BFF proxy — the playground's boot form needs one when the picked harness is a
// kind:"service" topology (a conversation session runs on a REGISTERED runtime, never the default compute).
// Failure → 502 envelope; the picker shows its empty text.
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.listRuntimes(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
