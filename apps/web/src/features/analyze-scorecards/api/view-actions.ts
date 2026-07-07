'use server'

import { revalidatePath } from 'next/cache'

import { viewSchema, type View, type ViewVisibility } from '@/entities/view'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ViewMutationResult {
  ok: boolean
  view?: View
  error?: string
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Save an analysis View — a named config (opaque stored map) + visibility. AuthZ is the control plane's (scorecards:run).
export async function createViewAction(input: {
  name: string
  config: Record<string, string>
  visibility: ViewVisibility
}): Promise<ViewMutationResult> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.createView<unknown>(ctx, input)
    const view = viewSchema.parse(raw)
    revalidatePath('/[workspace]/views')
    revalidatePath('/[workspace]/scorecards/analyze')
    return { ok: true, view }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}

// Edit a View — change name/visibility/config (owner or admin, control-plane enforced).
export async function updateViewAction(
  id: string,
  patch: { name?: string; config?: Record<string, string>; visibility?: ViewVisibility }
): Promise<ViewMutationResult> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.updateView<unknown>(ctx, id, patch)
    const view = viewSchema.parse(raw)
    revalidatePath('/[workspace]/views')
    revalidatePath('/[workspace]/scorecards/analyze')
    return { ok: true, view }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}

// Delete a View (owner or admin).
export async function deleteViewAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteView(ctx, id)
    revalidatePath('/[workspace]/views')
    revalidatePath('/[workspace]/scorecards/analyze')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}
