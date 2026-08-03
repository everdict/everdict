'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { initiativeSchema, type Initiative, type InitiativeStatus } from '@/entities/initiative'
import type { TrackerHealth } from '@/entities/tracker-health'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Tracker initiative server actions. Completing an initiative is a GATE: refused with a 409 while any issue
// under any of its projects is open. `force` closes it with known gaps and is recorded on the fact.

export interface InitiativeActionResult {
  ok: boolean
  initiative?: Initiative
  error?: string
  // Set when the completion gate refused — the count of issues still open under the goal.
  blockedBy?: number
}

const gatePayloadSchema = z.object({ openIssues: z.number() })
const errorEnvelopeSchema = z.object({
  message: z.string().optional(),
  data: z.unknown().optional(),
})

function revalidateInitiatives(): void {
  revalidatePath('/[workspace]/initiatives', 'page')
  // 상세는 탭 셋(개요·프로젝트·업데이트)이 한 레이아웃을 공유한다 — 레이아웃째 무효화해야 어느 탭에서
  // 바꾸든 나머지 두 탭이 옛 숫자를 들고 있지 않는다.
  revalidatePath('/[workspace]/initiatives/[id]', 'layout')
}

export async function createInitiativeAction(input: {
  name: string
  description?: string
  // 상위 이니셔티브 — 진척은 하위까지 훑어 올라오므로, 쪼개도 답은 하나로 남는다.
  parentId?: string
  lead?: string
  targetDate?: string
}): Promise<InitiativeActionResult> {
  const ctx = await authContext()
  try {
    const initiative = initiativeSchema.parse(await controlPlane.createInitiative(ctx, input))
    revalidateInitiatives()
    return { ok: true, initiative }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Projects join an initiative from the PROJECT side (PATCH /projects/:id), so membership is not editable here.
export async function updateInitiativeAction(
  id: string,
  patch: {
    name?: string
    description?: string | null
    // null 은 상위에서 떼어내 최상위로 되돌린다.
    parentId?: string | null
    // null 은 책임자를 비운다 — 아직 아무도 맡지 않았다는 건 실제 상태다.
    lead?: string | null
    targetDate?: string | null
  }
): Promise<InitiativeActionResult> {
  const ctx = await authContext()
  try {
    const initiative = initiativeSchema.parse(await controlPlane.updateInitiative(ctx, id, patch))
    revalidateInitiatives()
    return { ok: true, initiative }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function setInitiativeStatusAction(
  id: string,
  status: InitiativeStatus,
  force?: boolean
): Promise<InitiativeActionResult> {
  const ctx = await authContext()
  try {
    const res = await controlPlane.setInitiativeStatus(ctx, id, {
      status,
      ...(force ? { force: true } : {}),
    })
    if (res.ok) {
      const initiative = initiativeSchema.parse(res.body)
      revalidateInitiatives()
      return { ok: true, initiative }
    }
    const envelope = errorEnvelopeSchema.safeParse(res.body)
    const message = envelope.success ? envelope.data.message : undefined
    const gate = envelope.success ? gatePayloadSchema.safeParse(envelope.data.data) : undefined
    return {
      ok: false,
      ...(message ? { error: message } : {}),
      ...(res.status === 409 && gate?.success ? { blockedBy: gate.data.openIssues } : {}),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 업데이트 올리기 — 판정과 그 이유를 함께. 본문 없는 판정은 서버가 400 으로 거절한다.
export async function postInitiativeUpdateAction(
  id: string,
  input: { health: TrackerHealth; body: string }
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.postInitiativeUpdate(ctx, id, input)
    revalidateInitiatives()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteInitiativeAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteInitiative(ctx, id)
    revalidateInitiatives()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
