'use server'

import { revalidatePath } from 'next/cache'

import { createdInviteSchema } from '@/entities/member'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface CreateInviteResult {
  ok: boolean
  token?: string // inv_… plaintext (embedded in the link) — once only.
  error?: string
}

export interface InviteMutationResult {
  ok: boolean
  error?: string
}

// Create an invite. Receive the plaintext token once and share it via link. authZ (admin = members:write) is enforced by the control plane.
export async function createInviteAction(role: string): Promise<CreateInviteResult> {
  const ctx = await authContext()
  try {
    const res = createdInviteSchema.parse(await controlPlane.createInvite(ctx, { role }))
    revalidatePath('/[workspace]/settings')
    return { ok: true, token: res.token }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Revoke a pending invite. authZ (admin = members:write) is enforced by the control plane.
export async function revokeInviteAction(id: string): Promise<InviteMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.revokeInvite(ctx, id)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
