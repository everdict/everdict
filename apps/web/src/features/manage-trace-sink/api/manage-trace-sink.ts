'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface TraceSinkMutationResult {
  ok: boolean
  error?: string
}

// 트레이스 싱크 등록/갱신(관리자, name 기준 upsert). 인증 토큰(값)은 워크스페이스 시크릿에 먼저 넣고 그 이름만 지정.
// authZ(admin=settings:write)는 컨트롤플레인이 강제.
export async function upsertTraceSinkAction(input: {
  name: string
  kind: 'mlflow' | 'langfuse' | 'langsmith' | 'phoenix'
  endpoint: string
  authSecretName?: string
  project?: string
  webUrl?: string
}): Promise<TraceSinkMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.upsertTraceSink(ctx, input)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 트레이스 싱크 삭제(관리자). 그 싱크를 선택했던 하니스의 상세 결과는 이후 외부 적재 없이 Everdict 에만 남는다.
export async function removeTraceSinkAction(name: string): Promise<TraceSinkMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeTraceSink(ctx, name)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 하니스별 싱크 선택(멤버, harnesses:register). sink=null 이면 선택 해제(적재 안 함).
export async function assignHarnessTraceSinkAction(
  harnessId: string,
  sink: string | null
): Promise<TraceSinkMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.assignHarnessTraceSink(ctx, harnessId, { sink })
    revalidatePath('/[workspace]/settings')
    revalidatePath('/[workspace]/harnesses/[id]', 'page')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
