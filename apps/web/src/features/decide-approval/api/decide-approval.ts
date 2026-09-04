'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The caller's `refresh()` repaints — never revalidatePath (docs/web.md §"A mutation refreshes").
export interface DecideApprovalResult {
  ok: boolean
  error?: string
}

// Server action: approve or deny a parked agent mutation. AuthZ is the control plane's (`agents:write` —
// may 403), and so is the refusal for an approval that already expired or was decided: this action never
// pre-judges either, because the page's copy of the queue is a snapshot and the decision is not.
export async function decideApprovalAction(
  id: string,
  decision: 'approve' | 'deny'
): Promise<DecideApprovalResult> {
  const ctx = await authContext()
  try {
    await controlPlane.decideApproval(ctx, id, decision)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
