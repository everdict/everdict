'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface MemberMutationResult {
  ok: boolean
  error?: string
}

// 멤버 역할 변경. 마지막 admin 강등(409)·비멤버(404)·권한(403)은 컨트롤플레인이 강제.
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

// 멤버 제거(멱등). 마지막 admin 제거(409)·권한(403)은 컨트롤플레인이 강제.
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
