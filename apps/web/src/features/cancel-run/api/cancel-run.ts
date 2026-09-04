'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The caller's `refresh()` repaints — never revalidatePath (docs/web.md §"A mutation refreshes").
export interface CancelRunResult {
  ok: boolean
  error?: string
}

// Server action: stop one run. AuthZ and the terminal-state refusal are both the control plane's — a run
// that already settled answers 409, and this action does not pre-judge that, because the page's copy of the
// status is a snapshot and the run is not.
export async function cancelRunAction(id: string): Promise<CancelRunResult> {
  const ctx = await authContext()
  try {
    await controlPlane.cancelRun(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
