'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface LeaveWorkspaceResult {
  ok: boolean
  error?: string
}

// 활성 워크스페이스에서 나가기(self-serve) → DELETE /members/me. 마지막 admin 이면 컨트롤플레인이 409 로 막는다.
// 성공 시 클라이언트는 홈(/)으로 보내고, 홈이 남은 워크스페이스(또는 온보딩)로 다시 라우팅한다.
export async function leaveWorkspaceAction(): Promise<LeaveWorkspaceResult> {
  const ctx = await authContext()
  try {
    await controlPlane.leaveWorkspace(ctx)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
