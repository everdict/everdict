'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 컨트롤플레인 /models/validate 응답(느슨한 미러). ok=false 면 스키마 오류를 보여준다.
// missingSecrets = apiKeySecret 로 지정한 시크릿이 아직 워크스페이스에 없음(경고 — 등록은 막지 않음).
export interface ValidateModelResult {
  ok: boolean
  errors?: string[]
  versionExists?: boolean
  missingSecrets?: string[]
  error?: string
}

// 스키마 + 이 워크스페이스의 기존 버전/충돌 + apiKeySecret 존재 확인(등록하지 않음). 실패 시 {ok:false} 로 폼을 살려둔다.
export async function validateModelAction(spec: unknown): Promise<ValidateModelResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateModel<ValidateModelResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface CreateModelResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

// 등록(POST /models). authZ(models:write)는 컨트롤플레인이 강제. 버전은 불변이라 같은 버전 재등록은 서버가 409 로 막는다.
export async function createModelAction(spec: unknown): Promise<CreateModelResult> {
  const ctx = await authContext()
  try {
    const r = await controlPlane.createModel<{ id: string; version: string }>(ctx, spec)
    revalidatePath('/[workspace]/settings')
    return { ok: true, id: r.id, version: r.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 모델 전체 소프트-딜리트(DELETE /models/:id, versions 생략 = 이 워크스페이스 소유의 모든 라이브 버전). 툼스톤이라 이 모델을
// 참조했던 과거 스코어카드는 재현 가능하게 보존되지만, 이후 이 모델을 참조하는 실행은 해석에 실패한다. authZ(등록자-or-admin)는
// 컨트롤플레인이 강제 — fail-fast(하나라도 금지/부재면 아무것도 삭제 안 함).
export async function deleteModelAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteModelVersions<{ deleted: string[] }>(ctx, id)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
