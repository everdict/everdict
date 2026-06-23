'use server'

import { revalidatePath } from 'next/cache'

import { createdInviteSchema } from '@/entities/member'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface CreateInviteResult {
  ok: boolean
  token?: string // inv_… 평문(링크에 담음) — 1회만.
  error?: string
}

export interface InviteMutationResult {
  ok: boolean
  error?: string
}

// 초대 발급. 평문 토큰을 1회만 받아 링크로 공유. authZ(admin=members:write)는 컨트롤플레인이 강제.
export async function createInviteAction(
  role: string,
  expiresInHours?: number
): Promise<CreateInviteResult> {
  const ctx = await authContext()
  try {
    const body = expiresInHours !== undefined ? { role, expiresInHours } : { role }
    const res = createdInviteSchema.parse(await controlPlane.createInvite(ctx, body))
    revalidatePath('/[workspace]/settings')
    return { ok: true, token: res.token }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 대기중 초대 취소. authZ(admin=members:write)는 컨트롤플레인이 강제.
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
