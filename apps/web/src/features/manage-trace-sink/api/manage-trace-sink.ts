'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface TraceSinkMutationResult {
  ok: boolean
  error?: string
}

// 트레이스 싱크 등록/갱신(관리자). 인증 토큰(값)은 워크스페이스 시크릿에 먼저 넣고 그 이름만 지정.
// authZ(admin=settings:write)는 컨트롤플레인이 강제.
export async function setTraceSinkAction(input: {
  kind: 'mlflow' | 'langfuse' | 'langsmith' | 'phoenix'
  endpoint: string
  authSecretName?: string
  project?: string
  webUrl?: string
}): Promise<TraceSinkMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setTraceSink(ctx, input)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 트레이스 싱크 해제(관리자). 이후 스코어카드 상세 결과는 외부 적재 없이 Assay 에만 남는다.
export async function removeTraceSinkAction(): Promise<TraceSinkMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeTraceSink(ctx)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
