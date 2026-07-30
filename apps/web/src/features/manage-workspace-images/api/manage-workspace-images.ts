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

// 버전(태그) 하나의 상세 — 상세 화면에서 태그를 고를 때마다 호출된다. 실패는 결과로 돌려 화면이 요약으로 버틴다.
// (태그 목록은 상세 페이지가 서버에서 읽는다 — 목록 화면의 행 펼침이 상세 라우트로 승격되면서 클라이언트 액션은 없어졌다.)
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
