'use server'

import { revalidatePath } from 'next/cache'

import { workspaceImageRemoveSchema, workspaceImageTagsSchema } from '@/entities/workspace-image'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export type WorkspaceImageActionResult = { ok: true } | { ok: false; error: string }

// 리포지토리 회수(unpublish). 실패는 결과로 돌려주고(토스트용) 예외로 던지지 않는다 — 레지스트리가 죽어 있어도
// 패널 전체가 에러 화면으로 넘어가면 나머지 행을 못 다룬다.
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

// 태그는 목록에 딸려오지 않는다(리포지토리당 레지스트리 호출 1회) — 행을 펼칠 때만 가져온다.
export async function listWorkspaceImageTagsAction(
  repository: string
): Promise<{ ok: true; tags: string[] } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    const parsed = workspaceImageTagsSchema.parse(
      await controlPlane.listWorkspaceImageTags(ctx, repository)
    )
    return { ok: true, tags: parsed.tags }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
