'use server'

import { revalidatePath } from 'next/cache'

import { githubAppInstallStartSchema } from '@/entities/github-app'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface GithubAppMutationResult {
  ok: boolean
  error?: string
}

export interface GithubAppInstallResult extends GithubAppMutationResult {
  installUrl?: string
}

// GitHub App 설치 시작(관리자) → GitHub 설치 페이지 URL 반환(클라이언트가 이동). host 미지정=github.com.
// authZ(admin=settings:write)는 컨트롤플레인이 강제.
export async function startGithubAppInstallAction(host?: string): Promise<GithubAppInstallResult> {
  const ctx = await authContext()
  try {
    const out = githubAppInstallStartSchema.parse(
      await controlPlane.startGithubAppInstall(ctx, host ? { host } : {})
    )
    return { ok: true, installUrl: out.installUrl }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// GHE App 등록/갱신(관리자). App 개인키(PEM)는 SecretStore 에 먼저 넣고 그 이름만 지정.
export async function registerGithubAppAction(input: {
  host: string
  slug: string
  appId: string
  privateKeySecretName: string
}): Promise<GithubAppMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.registerGithubApp(ctx, input)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// GHE App 등록 해제(관리자).
export async function removeGithubAppRegistrationAction(
  host: string
): Promise<GithubAppMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeGithubAppRegistration(ctx, host)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// installation 링크 해제(관리자). 실제 uninstall 은 GitHub 쪽.
export async function unlinkGithubAppInstallationAction(
  installationId: number
): Promise<GithubAppMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.unlinkGithubAppInstallation(ctx, installationId)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
