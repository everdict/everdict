'use server'

import { revalidatePath } from 'next/cache'

import {
  workspaceImageInspectSchema,
  workspaceImageRemoveSchema,
  type WorkspaceImageInspect,
} from '@/entities/workspace-image'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export type WorkspaceImageActionResult = { ok: true } | { ok: false; error: string }

// Repository unpublish. A failure comes back as a RESULT (for a toast) rather than being thrown — with the registry down, the whole panel
// flipping to an error screen would leave the other rows unusable.
export async function removeWorkspaceImageAction(
  repository: string
): Promise<WorkspaceImageActionResult> {
  const ctx = await authContext()
  try {
    workspaceImageRemoveSchema.parse(await controlPlane.removeWorkspaceImage(ctx, repository))
    revalidatePath('/[workspace]/settings/images', 'page')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// One version (tag) detail — called each time a tag is picked on the detail screen. A failure comes back as a result so the screen holds with the summary.
// (The tag list is read on the server by the detail page — the client action disappeared when the list's row expansion was promoted to a detail route.)
export async function inspectWorkspaceImageAction(
  repository: string,
  reference: string
): Promise<{ ok: true; inspect: WorkspaceImageInspect } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    const inspect = workspaceImageInspectSchema.parse(
      await controlPlane.inspectWorkspaceImage(ctx, repository, reference)
    )
    return { ok: true, inspect }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
