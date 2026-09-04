'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Server action: phase 2 of a two-phase experiment — apply judges over an EXISTING group's runs and
// re-write the aggregate. Phase 1 is never re-executed, which is the whole point of the split: the compute
// is already spent, and judging it again costs only the judge.
export async function scoreGroupAction(
  id: string,
  judges: { id: string; version: string }[]
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.scoreGroup(ctx, id, judges)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
