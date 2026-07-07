'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface LeaveWorkspaceResult {
  ok: boolean
  error?: string
}

// Leave the active workspace (self-serve) → DELETE /members/me. If you're the last admin, the control plane blocks it with 409.
// On success, the client redirects to home (/), and home re-routes to a remaining workspace (or onboarding).
export async function leaveWorkspaceAction(): Promise<LeaveWorkspaceResult> {
  const ctx = await authContext()
  try {
    await controlPlane.leaveWorkspace(ctx)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
