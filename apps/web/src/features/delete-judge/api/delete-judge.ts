'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Delete one or more judge versions. The control plane exposes per-version soft-delete only (same tombstone model as
// harnesses — no whole-judge endpoint by design), so a whole-judge delete fans out over every live version here.
// Each delete is authorized server-side (the version's registrant or a workspace admin); a partial failure (e.g. a version
// registered by someone else) is reported per version rather than aborting the batch. Deleting every live version removes
// the judge entirely.
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
  // Broad revalidation so the judge list + detail reflect the removals (same pattern as the version-tags action).
  if (deleted.length > 0) revalidatePath('/[workspace]', 'layout')
  return { deleted, failed }
}
