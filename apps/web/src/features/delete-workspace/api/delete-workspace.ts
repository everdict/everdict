'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface DeleteWorkspaceResult {
  ok: boolean
  error?: string
}

// Delete the active workspace → DELETE /workspace. Owner (creator) only (the control plane verifies owner, else 403).
// On success, all workspace data is cascade-deleted. No revalidate — the client redirects to home to re-route.
export async function deleteWorkspaceAction(): Promise<DeleteWorkspaceResult> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteWorkspace(ctx)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
