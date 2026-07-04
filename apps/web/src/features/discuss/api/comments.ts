'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 리소스 제네릭 댓글 작성 — resourceType/resourceId, 선택적 parentId(대댓글), mentions(알림). authZ 는 컨트롤플레인.
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
    // 모든 상세 페이지에서 재검증(경로별 세그먼트가 달라 광범위하게 갱신).
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
