'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Server action: ask for an independent verification of a checkpoint. The verifier runs inside an
// EVIDENCE-ONLY envelope — empty write list, reads restricted to the tools that reach the cited evidence —
// so asking changes nothing except what is known about the handoff. That is why this needs no confirm.
export async function verifyCheckpointAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.verifyCheckpoint(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
