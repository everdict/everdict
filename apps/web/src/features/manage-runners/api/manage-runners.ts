'use server'

import { revalidatePath } from 'next/cache'

import { pairedRunnerSchema, pairRunnerInputSchema, type PairRunnerInput } from '@/entities/runner'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface PairRunnerResult {
  ok: boolean
  token?: string // 평문(rnr_…) — 1회만. 모달에 보여주고 버린다.
  error?: string
}
export interface RunnerMutationResult {
  ok: boolean
  error?: string
}

// 디바이스 페어링 — 컨트롤플레인이 rnr_… 평문을 1회 돌려준다(저장은 해시). 러너는 개인 소유(self-scoped by subject) — 역할 게이트 없음.
export async function pairRunnerAction(input: PairRunnerInput): Promise<PairRunnerResult> {
  const ctx = await authContext()
  try {
    // 경계 검증(컨트롤플레인이 다시 강제하지만 잘못된 입력은 여기서 거른다).
    const body = pairRunnerInputSchema.parse({
      label: input.label,
      ...(input.os && input.os.length > 0 ? { os: input.os } : {}),
      ...(input.capabilities && input.capabilities.length > 0
        ? { capabilities: input.capabilities }
        : {}),
    })
    const res = pairedRunnerSchema.parse(await controlPlane.pairRunner(ctx, body))
    revalidatePath('/[workspace]/account')
    return { ok: true, token: res.token }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 러너 해제(삭제). 러너는 개인 소유 — 본인 러너만 해제(컨트롤플레인이 subject 로 스코프).
export async function revokeRunnerAction(id: string): Promise<RunnerMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.revokeRunner(ctx, id)
    revalidatePath('/[workspace]/account')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
