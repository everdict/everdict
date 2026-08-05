'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface UpdateWorkspaceResult {
  ok: boolean
  error?: string
}

// Update workspace display info (name/logo) → PATCH /workspace. slug (URL) is immutable so it isn't sent.
// The control plane interprets an empty-string logoUrl as removing the logo. authZ (admin=settings:write) is enforced by the control plane.
export async function updateWorkspaceAction(input: {
  name?: string
  logoUrl?: string
}): Promise<UpdateWorkspaceResult> {
  const ctx = await authContext()
  try {
    await controlPlane.updateWorkspace(ctx, input)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
