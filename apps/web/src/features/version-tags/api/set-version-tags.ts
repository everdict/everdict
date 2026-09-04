'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Replace all version tags (empty array = remove all) — free-form labels outside the spec (to tell versions apart). authZ is enforced by the control plane
// (harnesses:register / datasets:write / runtimes:write / judges:write for rubrics; capabilities:write + creator-or-admin for a capability; _shared and other workspaces' versions 404).

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the
// DECLARATION alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
// `judge` was the one registry whose tags the web could not set — every other versioned entity had a
// branch here and judges did not, so a judge version could be labelled by an agent and not by a person.
// Census slice 5. docs/architecture/web-runtime-gap-census-spec.md
export type VersionTagEntity = 'harness' | 'dataset' | 'runtime' | 'rubric' | 'capability' | 'judge' | 'environment'

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
    else if (input.entity === 'rubric')
      await controlPlane.setRubricVersionTags(ctx, input.id, input.version, input.tags)
    else if (input.entity === 'capability')
      await controlPlane.setCapabilityVersionTags(ctx, input.id, input.version, input.tags)
    else if (input.entity === 'judge')
      await controlPlane.setJudgeVersionTags(ctx, input.id, input.version, input.tags)
    else if (input.entity === 'environment')
      await controlPlane.setEnvironmentVersionTags(ctx, input.id, input.version, input.tags)
    else await controlPlane.setRuntimeVersionTags(ctx, input.id, input.version, input.tags)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
