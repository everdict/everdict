'use server'

import { revalidatePath } from 'next/cache'

import { commentsResponseSchema } from '@/entities/comment'
import { membersSchema } from '@/entities/member'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import { buildThread } from '../lib/build'
import type { ThreadComment } from '../model/types'

// Resource-generic comment creation — resourceType/resourceId, optional parentId (reply), mentions (notifications),
// askAgent (@everdict — hand the thread to the discussion agent). AuthZ is the control plane's.
export async function createCommentAction(input: {
  resourceType: string
  resourceId: string
  body: string
  parentId?: string
  mentions?: string[]
  askAgent?: boolean
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.createComment(ctx, {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      body: input.body,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.mentions && input.mentions.length > 0 ? { mentions: input.mentions } : {}),
      ...(input.askAgent ? { askAgent: true } : {}),
    })
    // Revalidate across all detail pages (per-route segments differ, so refresh broadly).
    revalidatePath('/[workspace]', 'layout')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Fresh display-ready thread for client polling while an agent answer is in flight — built server-side (the
// client has no members/admin context), the same assembly CommentsSection does on first render.
export async function pollThreadAction(input: {
  resourceType: string
  resourceId: string
}): Promise<{ ok: boolean; thread?: ThreadComment[]; error?: string }> {
  try {
    const { principal, ctx } = await currentPrincipal()
    const comments = await controlPlane
      .listComments(ctx, input.resourceType, input.resourceId)
      .then((r) => commentsResponseSchema.parse(r).comments)
    const members = await controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch(() => [])
    const isAdmin = can(principal?.roles, 'settings:write')
    return { ok: true, thread: buildThread(comments, members, principal?.subject, isAdmin) }
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
