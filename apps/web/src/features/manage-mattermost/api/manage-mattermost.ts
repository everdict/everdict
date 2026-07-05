'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface MattermostMutationResult {
  ok: boolean
  error?: string
}

// Mattermost 통합 등록/갱신(관리자). bot 토큰(값)은 워크스페이스 시크릿에 먼저 넣고 그 이름만 지정.
// authZ(admin=settings:write)는 컨트롤플레인이 강제.
export async function setMattermostAction(input: {
  host: string
  botTokenSecretName: string
  defaultChannelId?: string
  commandTokenSecretName?: string
}): Promise<MattermostMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setMattermost(ctx, input)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Mattermost 통합 해제(관리자). 이후 완료/회귀 알림은 게시되지 않는다.
export async function removeMattermostAction(): Promise<MattermostMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeMattermost(ctx)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
