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

// 분석 View 저장 — 이름 붙인 config(불투명 stored 맵) + 가시성. authZ 는 컨트롤플레인(scorecards:run).
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

// View 수정 — 이름/가시성/설정 변경(소유자 또는 admin, 컨트롤플레인 강제).
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

// View 삭제(소유자 또는 admin).
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
