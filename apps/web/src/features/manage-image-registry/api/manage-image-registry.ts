'use server'

import { revalidatePath } from 'next/cache'

import { imageRegistrySetResponseSchema } from '@/entities/image-registry'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ImageRegistryMutationResult {
  ok: boolean
  error?: string
  missingSecrets?: string[] // 참조 시크릿 부재 경고(warn-not-block) — 저장은 됐고 시크릿만 나중에
}

// 이미지 레지스트리 등록/갱신(관리자, name 기준 upsert). pull/push 토큰(값)은 워크스페이스 시크릿에
// 먼저 넣고 그 이름만 지정. authZ(admin=settings:write)는 컨트롤플레인이 강제.
export async function upsertImageRegistryAction(input: {
  name: string
  host: string
  namespace?: string
  username?: string
  pullSecretName?: string
  pushSecretName?: string
}): Promise<ImageRegistryMutationResult> {
  const ctx = await authContext()
  try {
    const r = imageRegistrySetResponseSchema.parse(
      await controlPlane.upsertImageRegistry(ctx, input)
    )
    revalidatePath('/[workspace]/settings')
    return { ok: true, ...(r.missingSecrets ? { missingSecrets: r.missingSecrets } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 이미지 레지스트리 삭제(관리자). 이후 분류에서 그 레지스트리의 workspace 클래스는 나오지 않는다.
export async function removeImageRegistryAction(
  name: string
): Promise<ImageRegistryMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeImageRegistry(ctx, name)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
