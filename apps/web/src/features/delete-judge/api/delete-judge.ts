'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Delete one or more judge versions. The control plane exposes per-version soft-delete only (same tombstone model as
// harnesses — no whole-judge endpoint by design), so a whole-judge delete fans out over every live version here.
// Each delete is authorized server-side (the version's registrant or a workspace admin); a partial failure (e.g. a version
// registered by someone else) is reported per version rather than aborting the batch. Deleting every live version removes
// the judge entirely.

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the
// DECLARATION alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export async function deleteJudgeVersionsAction(input: {
  id: string
  versions: string[]
}): Promise<{ deleted: string[]; failed: { version: string; error: string }[] }> {
  const ctx = await authContext()
  const deleted: string[] = []
  const failed: { version: string; error: string }[] = []
  // Sequential — a judge's version list is small and order is irrelevant (independent tombstones); keeps control-plane load predictable.
  for (const version of input.versions) {
    try {
      await controlPlane.deleteJudgeVersion(ctx, input.id, version)
      deleted.push(version)
    } catch (e) {
      failed.push({ version, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { deleted, failed }
}
