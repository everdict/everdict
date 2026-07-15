'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Soft-delete dataset versions (tombstone — past scorecard results stay reproducible, but future runs referencing a
// deleted version fail to resolve). `versions` deletes exactly those; omitting it deletes the whole dataset (all own live
// versions). Backed by the control plane's bulk endpoint: it checks each target creator-or-admin and is atomic
// (fail-fast — nothing is deleted if any target is forbidden/absent), so this is one call, not a per-version fan-out.
export async function deleteDatasetVersionsAction(input: {
  id: string
  versions?: string[]
}): Promise<{ ok: boolean; deleted: string[]; error?: string }> {
  const ctx = await authContext()
  try {
    const res = await controlPlane.deleteDatasetVersions<{ deleted: string[] }>(
      ctx,
      input.id,
      input.versions
    )
    // Broad revalidation so the dataset list + detail reflect the removals (same pattern as the version-tags action).
    revalidatePath('/[workspace]', 'layout')
    return { ok: true, deleted: res.deleted }
  } catch (e) {
    return { ok: false, deleted: [], error: e instanceof Error ? e.message : String(e) }
  }
}
