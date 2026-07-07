'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface UpdateWorkspaceResult {
  ok: boolean
  error?: string
}

// Update workspace display info (name/logo) → PATCH /workspace. slug (URL) is immutable so it isn't sent.
// The control plane interprets an empty-string logoUrl as removing the logo. authZ (admin=settings:write) is enforced by the control plane.
export async function updateWorkspaceAction(input: {
  name?: string
  logoUrl?: string
}): Promise<UpdateWorkspaceResult> {
  const ctx = await authContext()
  try {
    await controlPlane.updateWorkspace(ctx, input)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
