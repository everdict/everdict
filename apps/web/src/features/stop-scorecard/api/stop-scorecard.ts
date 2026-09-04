'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the DECLARATION
// alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface StopScorecardResult {
  ok: boolean
  error?: string
}

// Server action: stop a running/queued batch with the authenticated user token. AuthZ is enforced by the control
// plane (scorecards:run — may 403; already-terminal → 409; other workspace / missing → 404). The scorecard's own
// AutoRefresh reflects the new `cancelled` status; the list's status chip is refreshed by the caller's `refresh()`.
export async function stopScorecardAction(id: string): Promise<StopScorecardResult> {
  const ctx = await authContext()
  try {
    await controlPlane.cancelScorecard(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
