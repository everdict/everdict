'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Workspace settings (control plane policy). Currently usage metering on/off.
export interface WorkspaceSettings {
  meterUsage?: boolean
}

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
