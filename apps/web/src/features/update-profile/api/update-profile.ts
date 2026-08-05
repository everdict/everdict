'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
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
