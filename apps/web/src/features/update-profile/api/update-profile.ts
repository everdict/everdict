'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface UpdateProfileResult {
  ok: boolean
  error?: string
}

// 내 프로필(이름/아바타) 수정 → PATCH /me/profile. email 은 SSO 라 보내지 않는다(읽기전용).
// 빈 문자열은 해당 필드 삭제로 컨트롤플레인이 해석한다. authZ 없음(자기 프로필).
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
