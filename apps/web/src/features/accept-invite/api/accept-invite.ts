'use server'

import { acceptedInviteSchema } from '@/entities/member'
import { setActiveWorkspace } from '@/shared/auth/active-workspace'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
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
    return { ok: true, workspace: res.workspace, role: res.role }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
