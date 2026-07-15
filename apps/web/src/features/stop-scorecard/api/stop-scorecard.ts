'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface StopScorecardResult {
  ok: boolean
  error?: string
}

// Server action: stop a running/queued batch with the authenticated user token. AuthZ is enforced by the control
// plane (scorecards:run — may 403; already-terminal → 409; other workspace / missing → 404). The scorecard's own
// AutoRefresh reflects the new `cancelled` status; we also revalidate the list so its status chip updates.
export async function stopScorecardAction(id: string): Promise<StopScorecardResult> {
  const ctx = await authContext()
  try {
    await controlPlane.cancelScorecard(ctx, id)
    revalidatePath('/[workspace]/scorecards')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
