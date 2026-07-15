'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Delete one or more harness versions. The control plane exposes per-version soft-delete only (same tombstone model as
// datasets — no whole-harness endpoint by design), so a whole-harness delete fans out over every live version here.
// Each delete is authorized server-side (the version's registrant or a workspace admin); a partial failure (e.g. a version
// registered by someone else) is reported per version rather than aborting the batch. Deleting every live version removes
// the harness entirely.
export async function deleteHarnessVersionsAction(input: {
  id: string
  versions: string[]
}): Promise<{ deleted: string[]; failed: { version: string; error: string }[] }> {
  const ctx = await authContext()
  const deleted: string[] = []
  const failed: { version: string; error: string }[] = []
  // Sequential — a harness's version list is small and order is irrelevant (independent tombstones); keeps control-plane load predictable.
  for (const version of input.versions) {
    try {
      await controlPlane.deleteHarnessVersion(ctx, input.id, version)
      deleted.push(version)
    } catch (e) {
      failed.push({ version, error: e instanceof Error ? e.message : String(e) })
    }
  }
  // Broad revalidation so the harness list + detail reflect the removals (same pattern as the version-tags action).
  if (deleted.length > 0) revalidatePath('/[workspace]', 'layout')
  return { deleted, failed }
}
