'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SetAgentToolResult {
  ok: boolean
  error?: string
}

// 내 에이전트 도구 on/off — 워크스페이스 AgentSpec 은 건드리지 않고 "나"의 오버레이만 바꾼다.
// enabled=null 은 오버라이드 해제(워크스페이스 기본값 따르기). 컨트롤플레인이 셀프 스코프를 강제한다.
export async function setAgentToolAction(
  key: string,
  enabled: boolean | null
): Promise<SetAgentToolResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setAgentTool(ctx, key, enabled)
    revalidatePath('/[workspace]/tools')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
