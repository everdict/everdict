'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the
// DECLARATION alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
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
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
