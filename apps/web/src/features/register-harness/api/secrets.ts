'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 컨트롤플레인 SecretNameSchema 와 동일(env 형식) — 폼 1차 검증, 최종 강제는 컨트롤플레인.
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

export interface CreateSecretResult {
  ok: boolean
  error?: string
}

// 하니스 env 에서 참조할 시크릿을 인라인으로 생성/갱신한다(값은 at-rest 암호화, 다시 못 봄).
// scope: "user"(내 개인, 셀프) | "workspace"(공유, admin). authZ 는 컨트롤플레인이 강제 — 권한 없으면 error.
export async function createSecretAction(
  name: string,
  value: string,
  scope: 'user' | 'workspace'
): Promise<CreateSecretResult> {
  if (!NAME_RE.test(name))
    return { ok: false, error: '이름은 대문자로 시작하고 대문자·숫자·밑줄만 쓸 수 있어요.' }
  if (value.length === 0) return { ok: false, error: '값이 비어 있어요.' }
  const ctx = await authContext()
  try {
    await controlPlane.setSecret(ctx, name, value, scope)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
