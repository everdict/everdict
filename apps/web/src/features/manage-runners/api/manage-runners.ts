'use server'

import { revalidatePath } from 'next/cache'

import {
  pairedRunnerSchema,
  pairRunnerInputSchema,
  type PairRunnerInput,
  type RunnerMeta,
} from '@/entities/runner'
import { authContext } from '@/shared/auth/principal'
import { env } from '@/shared/config/env'
import { controlPlane } from '@/shared/lib/control-plane'

export interface PairRunnerResult {
  ok: boolean
  token?: string // 평문(rnr_…) — 1회만. 모달에 보여주고 버리거나, 데스크톱 브리지로만 내려보낸다.
  runner?: RunnerMeta // 방금 페어된 러너 메타 — 데스크톱 원클릭이 runnerId 를 브리지에 넘길 때 사용
  apiUrl?: string // 러너가 접속할 컨트롤플레인 base(비밀 아님) — 데스크톱 브리지 전달용
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
    return { ok: true, token: res.token, runner: res.runner, apiUrl: env.CONTROL_PLANE_URL }
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
