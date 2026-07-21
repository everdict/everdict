'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface RunnerRevokeResult {
  ok: boolean
  error?: string
}

// Revoke a runner from its detail page. Personal runners are self-scoped by subject; a workspace-shared runner is
// admin-gated by the control plane (settings:write). The web just forwards — the control plane enforces ownership/role.
export async function revokeRunnerFromDetailAction(
  id: string,
  scope: 'personal' | 'workspace'
): Promise<RunnerRevokeResult> {
  const ctx = await authContext()
  try {
    if (scope === 'workspace') await controlPlane.revokeWorkspaceRunner(ctx, id)
    else await controlPlane.revokeRunner(ctx, id)
    revalidatePath('/[workspace]/runtimes')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
