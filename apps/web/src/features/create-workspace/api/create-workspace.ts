'use server'

import { setActiveWorkspace } from '@/shared/auth/active-workspace'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface CreateWorkspaceResult {
  ok: boolean
  id?: string
  name?: string
  error?: string
}

// Self-serve workspace creation (anyone) → the creator is admin. After creation, switch to that workspace immediately (cookie).
export async function createWorkspaceAction(input: {
  name: string
  id?: string
}): Promise<CreateWorkspaceResult> {
  const ctx = await authContext()
  try {
    const ws = await controlPlane.createWorkspace<{ id: string; name: string; role: string }>(ctx, {
      name: input.name,
      ...(input.id ? { id: input.id } : {}),
    })
    await setActiveWorkspace(ws.id)
    return { ok: true, id: ws.id, name: ws.name }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
