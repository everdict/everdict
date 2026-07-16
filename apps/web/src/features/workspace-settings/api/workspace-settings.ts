'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import type { WorkspaceSettings } from '../model/settings-schema'

// NB: this is a `'use server'` module — every export is treated as a server action, so the WorkspaceSettings TYPE is
// imported for the signature but NOT re-exported here. Consumers import the type from '../model/settings-schema'.

export interface UpdateSettingsResult {
  ok: boolean
  settings?: WorkspaceSettings
  error?: string
}

// Save a partial patch. authZ (admin=settings:write) is enforced by the control plane.
export async function updateWorkspaceSettingsAction(
  patch: WorkspaceSettings
): Promise<UpdateSettingsResult> {
  const ctx = await authContext()
  try {
    const settings = await controlPlane.setWorkspaceSettings<WorkspaceSettings>(ctx, patch)
    revalidatePath('/[workspace]/settings')
    return { ok: true, settings }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
