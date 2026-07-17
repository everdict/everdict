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
//  - "all"    — a FULL re-run (전체 재실행) via POST /scorecards/:id/rerun: re-runs every case with the original
//               config, optionally applying a re-score override (grading plan / judge model / trace sink).
//  - "failed" — recover only the FAILED cases via POST /scorecards/:id/retry: passing results carry over verbatim,
//               origin.retryOf keeps the lineage (a recovery lever — overrides don't apply, scoring stays consistent).
// AuthZ is the control plane's (scorecards:run — may 403; not terminal → 400; other workspace / missing → 404).
export async function rerunScorecardAction(input: {
  id: string
  scope: 'all' | 'failed'
  // Re-score overrides (full re-run only; ignored for the failed scope).
  graders?: { id: string; config?: Record<string, unknown> }[]
  traceSink?: string
  judgeModel?: string
}): Promise<RerunScorecardResult> {
  const ctx = await authContext()
  try {
    const created =
      input.scope === 'failed'
        ? await controlPlane.retryScorecard<{ id: string }>(ctx, input.id)
        : await controlPlane.rerunScorecard<{ id: string }>(ctx, input.id, {
            ...(input.graders && input.graders.length > 0 ? { graders: input.graders } : {}),
            ...(input.traceSink ? { traceSink: input.traceSink } : {}),
            ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
          })
    revalidatePath('/[workspace]/scorecards')
    revalidatePath('/[workspace]')
    return { ok: true, id: created.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
