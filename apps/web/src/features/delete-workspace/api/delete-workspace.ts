'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface DeleteWorkspaceResult {
  ok: boolean
  error?: string
}

// 활성 워크스페이스 삭제 → DELETE /workspace. owner(생성자)만 가능(컨트롤플레인이 owner 를 검증, 아니면 403).
// 성공 시 모든 워크스페이스 데이터가 cascade 삭제된다. revalidate 없음 — 클라이언트가 홈으로 보내 재라우팅.
export async function deleteWorkspaceAction(): Promise<DeleteWorkspaceResult> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteWorkspace(ctx)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
