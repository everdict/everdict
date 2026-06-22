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

// 초대 수락 — 토큰을 컨트롤플레인에 제출(인증만, 워크스페이스 게이트 없음). 성공 시 그 워크스페이스로 활성 전환.
// 만료/사용/무효(400/404/409)·머신키(400)는 컨트롤플레인이 강제하고 에러 메시지로 전달.
export async function acceptInviteAction(token: string): Promise<AcceptInviteResult> {
  const ctx = await authContext()
  try {
    const res = acceptedInviteSchema.parse(await controlPlane.acceptInvite(ctx, { token }))
    await setActiveWorkspace(res.workspace)
    revalidatePath('/dashboard', 'layout')
    return { ok: true, workspace: res.workspace, role: res.role }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
