'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

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
    revalidatePath('/[workspace]/account')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
