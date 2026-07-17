'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Bulk hard-delete of terminal scorecards. The control plane exposes single delete only (no batch endpoint), so a
// multi-select delete fans out over the chosen ids here — each authorized server-side (the batch's creator or a
// workspace admin) and an in-flight batch rejected with a conflict. A partial failure (permission / still-running) is
// reported per id rather than aborting the whole set, mirroring the harness version fan-out.
export async function deleteScorecardsAction(input: {
  ids: string[]
}): Promise<{ deleted: string[]; failed: { id: string; error: string }[] }> {
  const ctx = await authContext()
  const deleted: string[] = []
  const failed: { id: string; error: string }[] = []
  // Sequential — a selection is small and order is irrelevant (independent deletes); keeps control-plane load predictable.
  for (const id of input.ids) {
    try {
      await controlPlane.deleteScorecard(ctx, id)
      deleted.push(id)
    } catch (e) {
      failed.push({ id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  // Broad revalidation — the list, analyze/trend/leaderboard lenses, and the runs view all reflect the removals.
  if (deleted.length > 0) revalidatePath('/[workspace]', 'layout')
  return { deleted, failed }
}
