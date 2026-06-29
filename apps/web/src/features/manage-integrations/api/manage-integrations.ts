'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface IntegrationMutationResult {
  ok: boolean
  error?: string
}

// self-hosted 통합 OAuth 앱 등록/갱신(관리자). client_secret 값 자체는 입력하지 않는다 — SecretStore 키 이름만.
// authZ(admin=settings:write)는 컨트롤플레인이 강제.
export async function setIntegrationAction(
  provider: string,
  input: { host: string; clientId: string; clientSecretName: string }
): Promise<IntegrationMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setWorkspaceIntegration(ctx, provider, input)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// self-hosted 통합 해제(관리자). 기존 연결 토큰은 영향 없음 — 신규 연결만 막힌다.
export async function removeIntegrationAction(
  provider: string
): Promise<IntegrationMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeWorkspaceIntegration(ctx, provider)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
