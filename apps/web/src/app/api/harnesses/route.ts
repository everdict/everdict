import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Registered harnesses BFF proxy — the playground's boot form picks one on mount (versions/tags ride along on
// the list entry, so the version picker needs no second request). Failure → 502 envelope; the form shows the
// empty-picker text rather than blocking the panel.
export async function GET(): Promise<Response> {
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.listHarnesses(ctx))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
