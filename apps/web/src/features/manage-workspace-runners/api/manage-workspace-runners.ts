'use server'

import { revalidatePath } from 'next/cache'

import {
  githubRunnerInstallSchema,
  pairedRunnerSchema,
  pairRunnerInputSchema,
  type GithubRunnerInstall,
  type PairRunnerInput,
  type RunnerMeta,
} from '@/entities/runner'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Workspace-shared runner (team resource, owner=ws:<workspace>) — unlike personal runners (manage-runners), an
// admin (settings:write) registers/lists/revokes it. A registered runner is targetable via self:ws:<id> by any
// member of this workspace (team build server/CI). Pairing is headless (not one-click desktop) — it shows the
// plaintext token once and attaches on the server via `everdict runner --pair`.

export interface PairWorkspaceRunnerResult {
  ok: boolean
  token?: string // plaintext (rnr_…) — once only. Shown in the dialog/command then discarded (stored as a hash).
  runner?: RunnerMeta
  attachCommand?: string // server-authored, ready-to-run `everdict runner --pair …` (token embedded) — the dialog displays it verbatim.
  error?: string
}
export interface WorkspaceRunnerMutationResult {
  ok: boolean
  error?: string
}

export async function pairWorkspaceRunnerAction(
  input: PairRunnerInput
): Promise<PairWorkspaceRunnerResult> {
  const ctx = await authContext()
  try {
    const body = pairRunnerInputSchema.parse({
      label: input.label,
      ...(input.os && input.os.length > 0 ? { os: input.os } : {}),
      ...(input.capabilities && input.capabilities.length > 0
        ? { capabilities: input.capabilities }
        : {}),
    })
    const res = pairedRunnerSchema.parse(await controlPlane.pairWorkspaceRunner(ctx, body))
    revalidatePath('/[workspace]/settings')
    return {
      ok: true,
      token: res.token,
      runner: res.runner,
      ...(res.attachCommand !== undefined ? { attachCommand: res.attachCommand } : {}),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function revokeWorkspaceRunnerAction(
  id: string
): Promise<WorkspaceRunnerMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.revokeWorkspaceRunner(ctx, id)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface GithubInstallResult {
  ok: boolean
  install?: GithubRunnerInstall // install script + workflow hint (the script contains the plaintext token — shown once)
  error?: string
}

// GitHub Actions runner self-registration — pairs a new workspace-shared runner and mints a registration token
// via the workspace GitHub App, returning an install script that stands up two workers (GitHub runner + Everdict
// runner) on a single build server. admin (settings:write). The target is exactly one of repo (owner/name) or org
// (org name) — the App must be installed on that org/repo. host = the GHE base URL of that target's installation
// (the picker carries it) — unset = github.com first.
export async function githubInstallRunnerAction(input: {
  repository?: string
  org?: string
  host?: string
  runnerGroup?: string
  label?: string
}): Promise<GithubInstallResult> {
  const ctx = await authContext()
  try {
    const body = {
      ...(input.repository && input.repository.trim().length > 0
        ? { repository: input.repository.trim() }
        : {}),
      ...(input.org && input.org.trim().length > 0 ? { org: input.org.trim() } : {}),
      ...(input.host && input.host.trim().length > 0 ? { host: input.host.trim() } : {}),
      ...(input.runnerGroup && input.runnerGroup.trim().length > 0
        ? { runnerGroup: input.runnerGroup.trim() }
        : {}),
      ...(input.label && input.label.trim().length > 0 ? { label: input.label.trim() } : {}),
    }
    const install = githubRunnerInstallSchema.parse(
      await controlPlane.githubInstallWorkspaceRunner(ctx, body)
    )
    revalidatePath('/[workspace]/settings')
    return { ok: true, install }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
