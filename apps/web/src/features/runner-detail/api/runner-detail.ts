'use server'

import { revalidatePath } from 'next/cache'

import { runsSchema, type Run } from '@/entities/run'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface RunnerRevokeResult {
  ok: boolean
  error?: string
}

export type RunnerRunsResult =
  | { ok: true; runs: Run[]; hasMore: boolean }
  | { ok: false; error: string }

// One page of the runs a self-hosted runner executed (runner-detail activity feed), offset-paginated. Fetches
// `pageSize + 1` rows to tell whether a next page exists (the extra row is trimmed off the returned page). This keeps
// each fetch bounded to one page instead of pulling the whole history on every render/refresh. authZ (runs:read) is
// enforced by the control plane.
export async function listRunnerRunsAction(
  runnerId: string,
  page: number,
  pageSize: number
): Promise<RunnerRunsResult> {
  const ctx = await authContext()
  try {
    const rows = runsSchema.parse(
      await controlPlane.listRuns(ctx, {
        runner: runnerId,
        limit: pageSize + 1,
        offset: page * pageSize,
      })
    )
    return { ok: true, runs: rows.slice(0, pageSize), hasMore: rows.length > pageSize }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Revoke a runner from its detail page. Personal runners are self-scoped by subject; a workspace-shared runner is
// admin-gated by the control plane (settings:write). The web just forwards — the control plane enforces ownership/role.
export async function revokeRunnerFromDetailAction(
  id: string,
  scope: 'personal' | 'workspace'
): Promise<RunnerRevokeResult> {
  const ctx = await authContext()
  try {
    if (scope === 'workspace') await controlPlane.revokeWorkspaceRunner(ctx, id)
    else await controlPlane.revokeRunner(ctx, id)
    revalidatePath('/[workspace]/runtimes')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
