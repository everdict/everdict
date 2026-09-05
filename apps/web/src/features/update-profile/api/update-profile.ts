'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the
// DECLARATION alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface UpdateProfileResult {
  ok: boolean
  error?: string
}

// Update my profile (name/avatar) → PATCH /me/profile. email is SSO so it isn't sent (read-only).
// The control plane interprets an empty string as deleting that field. No authZ (own profile).
export async function updateProfileAction(input: {
  name: string
  avatarUrl: string
}): Promise<UpdateProfileResult> {
  const ctx = await authContext()
  try {
    await controlPlane.updateProfile(ctx, input)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
