'use server'

import { revalidatePath } from 'next/cache'

import { acceptedInviteSchema } from '@/entities/member'
import { setActiveWorkspace } from '@/shared/auth/active-workspace'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface AcceptInviteResult {
  ok: boolean
  workspace?: string
  role?: string
  error?: string
}

// Accept an invite — submit the token to the control plane (auth only, no workspace gate). On success, switch active to that workspace.
// Expired/used/invalid (400/404/409) and machine keys (400) are enforced by the control plane and surfaced as the error message.
export async function acceptInviteAction(token: string): Promise<AcceptInviteResult> {
  const ctx = await authContext()
  try {
    const res = acceptedInviteSchema.parse(await controlPlane.acceptInvite(ctx, { token }))
    await setActiveWorkspace(res.workspace)
    revalidatePath('/[workspace]', 'layout')
    return { ok: true, workspace: res.workspace, role: res.role }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
