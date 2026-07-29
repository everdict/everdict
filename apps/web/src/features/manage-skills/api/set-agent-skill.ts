'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SetAgentSkillResult {
  ok: boolean
  error?: string
}

// 내 에이전트가 따르는 스킬 on/off — 워크스페이스 라이브러리는 그대로 두고 "나"의 오버레이만 바꾼다.
// enabled=null 은 오버라이드 해제(워크스페이스 기본값 따르기). 컨트롤플레인이 셀프 스코프를 강제한다.
export async function setAgentSkillAction(
  key: string,
  enabled: boolean | null
): Promise<SetAgentSkillResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setAgentSkill(ctx, key, enabled)
    revalidatePath('/[workspace]/settings/skills')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
