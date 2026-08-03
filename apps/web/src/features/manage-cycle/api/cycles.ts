'use server'

import { revalidatePath } from 'next/cache'

import { cycleSchema, type Cycle } from '@/entities/cycle'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 사이클 서버 액션 — 제어 평면의 /cycles 를 그대로 부르는 HTTP 클라이언트다. 번호 발번, 창 제안, 이월은
// 전부 서버가 하고 여기서는 아무것도 판단하지 않는다.

export interface CycleActionResult {
  ok: boolean
  cycle?: Cycle
  error?: string
}

function revalidateCycles(): void {
  revalidatePath('/[workspace]/cycles', 'page')
  revalidatePath('/[workspace]/cycles/[id]', 'page')
  revalidatePath('/[workspace]/issues', 'page')
}

export async function createCycleAction(input: {
  teamId: string
  name?: string
  description?: string
  // 둘 다 주거나 둘 다 비운다 — 비우면 팀의 주기에서 제안된 창이 온다(반쪽은 서버가 400 으로 거절).
  startsAt?: string
  endsAt?: string
}): Promise<CycleActionResult> {
  const ctx = await authContext()
  try {
    const cycle = cycleSchema.parse(await controlPlane.createCycle(ctx, input))
    revalidateCycles()
    return { ok: true, cycle }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function updateCycleAction(
  id: string,
  patch: { name?: string | null; description?: string | null; startsAt?: string; endsAt?: string }
): Promise<CycleActionResult> {
  const ctx = await authContext()
  try {
    const cycle = cycleSchema.parse(await controlPlane.updateCycle(ctx, id, patch))
    revalidateCycles()
    return { ok: true, cycle }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 종료 + 이월. 게이트가 아니므로 실패는 곧 서버의 거절(이미 닫힘·다른 팀 사이클)이고, 그대로 보여 준다.
export async function completeCycleAction(
  id: string,
  moveUnfinishedTo?: string
): Promise<CycleActionResult> {
  const ctx = await authContext()
  try {
    const cycle = cycleSchema.parse(
      await controlPlane.completeCycle(ctx, id, moveUnfinishedTo ? { moveUnfinishedTo } : {})
    )
    revalidateCycles()
    return { ok: true, cycle }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteCycleAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteCycle(ctx, id)
    revalidateCycles()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
