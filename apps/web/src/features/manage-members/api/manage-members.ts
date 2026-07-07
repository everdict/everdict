'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface MemberMutationResult {
  ok: boolean
  error?: string
}

// Change a member's role. Last-admin demotion (409), non-member (404), and permission (403) are enforced by the control plane.
export async function setMemberRoleAction(
  subject: string,
  role: string
): Promise<MemberMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setMemberRole(ctx, subject, role)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Remove a member (idempotent). Last-admin removal (409) and permission (403) are enforced by the control plane.
export async function removeMemberAction(subject: string): Promise<MemberMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeMember(ctx, subject)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
