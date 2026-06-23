'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface UpdateWorkspaceResult {
  ok: boolean
  error?: string
}

// 워크스페이스 표시 정보(이름/로고) 수정 → PATCH /workspace. slug(URL)은 불변이라 보내지 않는다.
// 빈 문자열 logoUrl 은 로고 제거로 컨트롤플레인이 해석한다. authZ(admin=settings:write)는 컨트롤플레인이 강제.
export async function updateWorkspaceAction(input: {
  name?: string
  logoUrl?: string
}): Promise<UpdateWorkspaceResult> {
  const ctx = await authContext()
  try {
    await controlPlane.updateWorkspace(ctx, input)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
