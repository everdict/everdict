'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface RerunScorecardResult {
  ok: boolean
  id?: string // the NEW scorecard's id (both scopes create a fresh batch; the source is never mutated)
  error?: string
}

// Server action: re-run a TERMINAL scorecard as a new batch. Two scopes:
//  - "all"    — a FULL re-run (전체 재실행) via POST /scorecards/:id/rerun: re-runs every case, reproducing the
//               original config while optionally adjusting the two run-config choices made at submit time —
//               the selected judges and the execution runtime (unset = inherit the original).
//  - "failed" — recover only the FAILED cases via POST /scorecards/:id/retry: passing results carry over verbatim,
//               origin.retryOf keeps the lineage (a recovery lever — the original config is reproduced as-is).
// AuthZ is the control plane's (scorecards:run — may 403; not terminal → 400; other workspace / missing → 404).
export async function rerunScorecardAction(input: {
  id: string
  scope: 'all' | 'failed'
  // Run-config overrides (full re-run only; ignored for the failed scope).
  judges?: { id: string; version: string }[] // [] re-runs with no judges; omitted = inherit the original selection
  runtime?: string
}): Promise<RerunScorecardResult> {
  const ctx = await authContext()
  try {
    const created =
      input.scope === 'failed'
        ? await controlPlane.retryScorecard<{ id: string }>(ctx, input.id)
        : await controlPlane.rerunScorecard<{ id: string }>(ctx, input.id, {
            ...(input.judges ? { judges: input.judges } : {}),
            ...(input.runtime ? { runtime: input.runtime } : {}),
          })
    revalidatePath('/[workspace]/scorecards')
    revalidatePath('/[workspace]')
    return { ok: true, id: created.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
