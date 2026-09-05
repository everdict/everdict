'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Bulk hard-delete of terminal scorecards. The control plane exposes single delete only (no batch endpoint), so a
// multi-select delete fans out over the chosen ids here — each authorized server-side (the batch's creator or a
// workspace admin) and an in-flight batch rejected with a conflict. A partial failure (permission / still-running) is
// reported per id rather than aborting the whole set, mirroring the harness version fan-out.

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the
// DECLARATION alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
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
  return { deleted, failed }
}
