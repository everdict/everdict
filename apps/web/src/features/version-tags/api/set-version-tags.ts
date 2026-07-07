'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Replace all version tags (empty array = remove all) — free-form labels outside the spec (to tell versions apart). authZ is enforced by the control plane
// (harnesses:register / datasets:write / runtimes:write; _shared and other workspaces' versions 404).
export type VersionTagEntity = 'harness' | 'dataset' | 'runtime'

export async function setVersionTagsAction(input: {
  entity: VersionTagEntity
  id: string
  version: string
  tags: string[]
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    if (input.entity === 'harness')
      await controlPlane.setHarnessVersionTags(ctx, input.id, input.version, input.tags)
    else if (input.entity === 'dataset')
      await controlPlane.setDatasetVersionTags(ctx, input.id, input.version, input.tags)
    else await controlPlane.setRuntimeVersionTags(ctx, input.id, input.version, input.tags)
    // Broad revalidation so the latest tags show up anywhere — detail/list/run forms (same pattern as the comment action).
    revalidatePath('/[workspace]', 'layout')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
