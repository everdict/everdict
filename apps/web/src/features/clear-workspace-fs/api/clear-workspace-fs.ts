'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Server action: empty the WHOLE workspace tree. Governance rather than content mutation — admin-only at
// the control plane, and deliberately the UNSCOPED service: emptying a workspace has to mean emptying it,
// and a member-scoped clear would silently leave every other member's files behind for the next tenant of
// the same workspace. That is why the confirm below asks for the workspace name rather than a yes.
export async function clearWorkspaceFsAction(): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.clearWorkspaceFs(ctx)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
