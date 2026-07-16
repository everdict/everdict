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

// Start GitHub App install (admin) → returns the GitHub install-page URL (the client navigates). host unset = github.com,
// host set = the operator-configured GitHub Enterprise host (both env — install-only). authZ (settings:write) is enforced by the control plane.
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

// Unlink installation (admin). The actual uninstall happens on the GitHub side.
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
