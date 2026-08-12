'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SetAgentModelResult {
  ok: boolean
  error?: string
}

// 내 대화의 기본 LLM — 워크스페이스 AgentSpec(관리자가 모두를 위해 고른 하나)은 건드리지 않고 "나"의 오버레이만 바꾼다.
// model=null 은 선택 해제(= 워크스페이스 기본값 따르기). 등록되지 않은 모델 id 는 컨트롤플레인이 404 로 거절한다.
export async function setAgentModelAction(model: string | null): Promise<SetAgentModelResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setAgentModel(ctx, model)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
