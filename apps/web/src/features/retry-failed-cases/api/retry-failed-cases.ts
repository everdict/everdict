'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface RetryFailedResult {
  ok: boolean
  id?: string // the NEW scorecard's id (retry re-runs the failed cases as a fresh batch; passing cases carry over)
  error?: string
}

// Server action: re-run only the FAILED cases of a terminal batch as a new scorecard (passing results are carried over
// verbatim, origin.retryOf keeps the lineage — the source record is never mutated). AuthZ is the control plane's
// (scorecards:run — may 403; not terminal / nothing failed → 400; other workspace / missing → 404). On success we
// revalidate the list and hand the new id back so the button can navigate to the fresh run.
export async function retryFailedCasesAction(id: string): Promise<RetryFailedResult> {
  const ctx = await authContext()
  try {
    const created = await controlPlane.retryScorecard<{ id: string }>(ctx, id)
    revalidatePath('/[workspace]/scorecards')
    return { ok: true, id: created.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
