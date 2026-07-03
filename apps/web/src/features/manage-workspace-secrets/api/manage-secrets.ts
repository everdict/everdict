'use server'

import { revalidatePath } from 'next/cache'

import type { SecretScope } from '@/entities/secret'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SecretMutationResult {
  ok: boolean
  error?: string
}

// env 형식 이름(컨트롤플레인 SecretNameSchema 와 동일) — 폼 단에서 1차 검증, 최종 강제는 컨트롤플레인.
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

// 스코프별 변경 후 재검증 — user(개인)=계정 화면, workspace(공유)=워크스페이스 설정.
function revalidateFor(scope: SecretScope): void {
  revalidatePath(scope === 'user' ? '/[workspace]/account' : '/[workspace]/settings')
}

// 시크릿 설정/갱신(at-rest 암호화; 값은 다시 못 봄). scope=workspace(admin) | user(본인 셀프). authZ 는 컨트롤플레인이 강제.
export async function setSecretAction(
  name: string,
  value: string,
  scope: SecretScope
): Promise<SecretMutationResult> {
  if (!NAME_RE.test(name))
    return { ok: false, error: '이름은 ^[A-Z_][A-Z0-9_]*$ 형식이어야 합니다.' }
  if (value.length === 0) return { ok: false, error: '값이 비어 있습니다.' }
  const ctx = await authContext()
  try {
    await controlPlane.setSecret(ctx, name, value, scope)
    revalidateFor(scope)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 시크릿 삭제. scope 로 스코프(공유/개인) 지정. authZ 는 컨트롤플레인이 강제.
export async function deleteSecretAction(
  name: string,
  scope: SecretScope
): Promise<SecretMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteSecret(ctx, name, scope)
    revalidateFor(scope)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
