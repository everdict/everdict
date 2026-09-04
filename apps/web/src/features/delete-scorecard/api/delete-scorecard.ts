'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Hard-delete a terminal scorecard (record + child runs). The control plane authorizes (the batch's creator or a
// workspace admin) and rejects an in-flight batch with a conflict (stop it first) — the failure message is returned
// instead of thrown so the dialog can surface it inline (same posture as delete-judge's per-version failures).

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the
// DECLARATION alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export async function deleteScorecardAction(input: {
  id: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteScorecard(ctx, input.id)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true }
}
