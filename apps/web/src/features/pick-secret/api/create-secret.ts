'use server'

import { getTranslations } from 'next-intl/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 컨트롤플레인 SecretNameSchema 와 동일(env 형식) — 폼 1차 검증, 최종 강제는 컨트롤플레인.
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

export interface CreateSecretResult {
  ok: boolean
  error?: string
}

// 시크릿 참조 입력(하니스 env·GHE App 개인키·Mattermost 토큰 등)에서 인라인으로 생성/갱신한다
// (값은 at-rest 암호화, 다시 못 봄). scope: "user"(내 개인, 셀프) | "workspace"(공유, admin).
// authZ 는 컨트롤플레인이 강제 — 권한 없으면 error.
export async function createSecretAction(
  name: string,
  value: string,
  scope: 'user' | 'workspace'
): Promise<CreateSecretResult> {
  const t = await getTranslations('pickSecret')
  if (!NAME_RE.test(name)) return { ok: false, error: t('nameInvalidServer') }
  if (value.length === 0) return { ok: false, error: t('valueEmpty') }
  const ctx = await authContext()
  try {
    await controlPlane.setSecret(ctx, name, value, scope)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
