'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 데이터셋 댓글 작성/삭제 서버 액션 — 조회는 상세 페이지(서버)에서 직접. authZ 는 컨트롤플레인이 강제.
export async function createCommentAction(
  resourceId: string,
  body: string,
  mentions: string[] = []
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.createComment(ctx, {
      resourceType: 'dataset',
      resourceId,
      body,
      ...(mentions.length > 0 ? { mentions } : {}),
    })
    revalidatePath('/[workspace]/datasets/[id]', 'page')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteCommentAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteComment(ctx, id)
    revalidatePath('/[workspace]/datasets/[id]', 'page')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
