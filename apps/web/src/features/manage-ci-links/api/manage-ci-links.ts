'use server'

import { revalidatePath } from 'next/cache'

import {
  ciLinksResponseSchema,
  reposSchema,
  setupPrResultSchema,
  type CiLink,
  type RepoInfo,
} from '@/entities/ci-link'
import { runnersResponseSchema, type RunnerMeta } from '@/entities/runner'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ReposResult {
  ok: boolean
  repos?: RepoInfo[]
  error?: string
}
export interface SharedRunnersResult {
  ok: boolean
  runners?: RunnerMeta[]
  error?: string
}
export interface CiLinksResult {
  ok: boolean
  links?: CiLink[]
  error?: string
}
export interface SetupPrResult {
  ok: boolean
  prUrl?: string
  error?: string
}

// Upsert link (repo↔harness slot) input — dataset/slots/runsOn/runtime are optional. The control plane does the final validation (admin gate).
export interface UpsertCiLinkInput {
  repository: string
  host?: string // GHE base URL (e.g. https://ghe.acme.io) — unset = github.com
  harness: string
  dataset?: string
  slots?: Record<string, { path?: string }>
  runsOn?: string // narrowing override — workflow runs-on (default [self-hosted])
  runtime?: string // narrowing override — run-eval runtime (default self:ws pool, e.g. self:ws:<id>)
  trigger?: 'auto' | 'comment' | 'both' // PR evaluation trigger mode — unset = both (automatic + /evaluate comment)
}

// Workspace shared runners (team-owned) list — CI dispatch is always self-hosted (default self:ws pool), so the connect dialog
// shows runner readiness. Control-plane gate = settings:write — only call when canWrite (admin).
export async function listSharedRunnersAction(): Promise<SharedRunnersResult> {
  const ctx = await authContext()
  try {
    const { runners } = runnersResponseSchema.parse(
      await controlPlane.listWorkspaceOwnedRunners(ctx)
    )
    return { ok: true, runners }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Repo list (picker) — repos the workspace GitHub App installation can access (only those chosen at install time). settings:read.
export async function listGithubAppReposAction(): Promise<ReposResult> {
  const ctx = await authContext()
  try {
    const repos = reposSchema.parse(await controlPlane.getGithubAppRepos(ctx))
    return { ok: true, repos }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Save link (create/update) — a link's existence grants that repo's keyless CI trust (settings:write=admin, enforced by the control plane).
export async function upsertCiLinkAction(input: UpsertCiLinkInput): Promise<CiLinksResult> {
  const ctx = await authContext()
  try {
    const { links } = ciLinksResponseSchema.parse(await controlPlane.upsertCiLink(ctx, input))
    revalidatePath('/[workspace]/harnesses/[id]', 'page')
    revalidatePath('/[workspace]/settings', 'page')
    return { ok: true, links }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Unlink (delete) — settings:write (admin). host unset = github.com link.
export async function deleteCiLinkAction(
  repository: string,
  host?: string
): Promise<CiLinksResult> {
  const ctx = await authContext()
  try {
    const { links } = ciLinksResponseSchema.parse(
      await controlPlane.deleteCiLink(ctx, repository, host)
    )
    revalidatePath('/[workspace]/harnesses/[id]', 'page')
    revalidatePath('/[workspace]/settings', 'page')
    return { ok: true, links }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Open setup PR — PRs the link's workflow YAML into the target repo (workspace GitHub App token). harnesses:read (the merge is approved on the GitHub side).
export async function openSetupPrAction(repository: string, host?: string): Promise<SetupPrResult> {
  const ctx = await authContext()
  try {
    const { prUrl } = setupPrResultSchema.parse(
      await controlPlane.setupCiLinkPr(ctx, { repository, ...(host ? { host } : {}) })
    )
    return { ok: true, prUrl }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
