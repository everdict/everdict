'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Resource-generic comment creation — resourceType/resourceId, optional parentId (reply), mentions (notifications). AuthZ is the control plane's.
export async function createCommentAction(input: {
  resourceType: string
  resourceId: string
  body: string
  parentId?: string
  mentions?: string[]
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.createComment(ctx, {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      body: input.body,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.mentions && input.mentions.length > 0 ? { mentions: input.mentions } : {}),
    })
    // Revalidate across all detail pages (per-route segments differ, so refresh broadly).
    revalidatePath('/[workspace]', 'layout')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteCommentAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteComment(ctx, id)
    revalidatePath('/[workspace]', 'layout')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
