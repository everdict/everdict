'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SecretMutationResult {
  ok: boolean
  error?: string
}

// env 형식 이름(컨트롤플레인 SecretNameSchema 와 동일) — 폼 단에서 1차 검증, 최종 강제는 컨트롤플레인.
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

// 시크릿 설정/갱신(at-rest 암호화; 값은 다시 못 봄). authZ(admin=secrets:write)는 컨트롤플레인이 강제.
export async function setSecretAction(name: string, value: string): Promise<SecretMutationResult> {
  if (!NAME_RE.test(name))
    return { ok: false, error: '이름은 ^[A-Z_][A-Z0-9_]*$ 형식이어야 합니다.' }
  if (value.length === 0) return { ok: false, error: '값이 비어 있습니다.' }
  const ctx = await authContext()
  try {
    await controlPlane.setSecret(ctx, name, value)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 시크릿 삭제. authZ(admin=secrets:write)는 컨트롤플레인이 강제.
export async function deleteSecretAction(name: string): Promise<SecretMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteSecret(ctx, name)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
