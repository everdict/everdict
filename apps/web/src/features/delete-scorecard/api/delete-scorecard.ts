'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Hard-delete a terminal scorecard (record + child runs). The control plane authorizes (the batch's creator or a
// workspace admin) and rejects an in-flight batch with a conflict (stop it first) — the failure message is returned
// instead of thrown so the dialog can surface it inline (same posture as delete-judge's per-version failures).
export async function deleteScorecardAction(input: {
  id: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteScorecard(ctx, input.id)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  // Broad revalidation — the list, analyze/trend/leaderboard lenses, and the runs view all reflect the removal.
  revalidatePath('/[workspace]', 'layout')
  return { ok: true }
}
