'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The caller's `refresh()` repaints — never revalidatePath (docs/web.md §"A mutation refreshes").
export interface RetryCasesResult {
  ok: boolean
  error?: string
}

// Server action: re-run the named cases INSIDE this scorecard. The attempt each one replaces is preserved on
// the record, so the case row can say how many times it has run. AuthZ is the control plane's
// (scorecards:run — may 403); a case that already reached a verdict needs `reason`, which the control plane
// refuses with a 400 rather than this action guessing.
export async function retryScorecardCasesAction(
  id: string,
  cases: Array<{ caseId: string; trial?: number }>,
  reason?: string,
): Promise<RetryCasesResult> {
  const ctx = await authContext()
  try {
    await controlPlane.retryScorecardCases(ctx, id, { cases, ...(reason ? { reason } : {}) })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
