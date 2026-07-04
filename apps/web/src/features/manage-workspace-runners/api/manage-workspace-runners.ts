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

// 워크스페이스-공유 러너(팀 자원, owner=ws:<workspace>) — 개인 러너(manage-runners)와 달리 admin(settings:write)이
// 등록/조회/해제한다. 등록된 러너는 이 워크스페이스 멤버 누구나 self:ws:<id> 로 타깃(팀 빌드서버/CI). 페어링은
// headless(원클릭 데스크톱 아님) — 평문 토큰을 1회 노출하고 서버에서 `assay runner --pair` 로 붙인다.

export interface PairWorkspaceRunnerResult {
  ok: boolean
  token?: string // 평문(rnr_…) — 1회만. 모달/명령에 보여주고 버린다(저장은 해시).
  runner?: RunnerMeta
  apiUrl?: string // 러너가 접속할 컨트롤플레인 base(비밀 아님) — `assay runner` 명령에 넣어 보여준다.
  error?: string
}
export interface WorkspaceRunnerMutationResult {
  ok: boolean
  error?: string
}

export async function pairWorkspaceRunnerAction(
  input: PairRunnerInput
): Promise<PairWorkspaceRunnerResult> {
  const ctx = await authContext()
  try {
    const body = pairRunnerInputSchema.parse({
      label: input.label,
      ...(input.os && input.os.length > 0 ? { os: input.os } : {}),
      ...(input.capabilities && input.capabilities.length > 0
        ? { capabilities: input.capabilities }
        : {}),
    })
    const res = pairedRunnerSchema.parse(await controlPlane.pairWorkspaceRunner(ctx, body))
    revalidatePath('/[workspace]/settings')
    return { ok: true, token: res.token, runner: res.runner, apiUrl: env.CONTROL_PLANE_URL }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function revokeWorkspaceRunnerAction(
  id: string
): Promise<WorkspaceRunnerMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.revokeWorkspaceRunner(ctx, id)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
