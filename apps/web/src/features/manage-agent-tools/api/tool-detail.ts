'use server'

import { revalidatePath } from 'next/cache'

import {
  agentToolDetailSchema,
  agentToolProbeSchema,
  type AgentToolDetail,
  type AgentToolProbe,
} from '@/entities/agent-tool'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 도구 상세 화면의 두 동작 — 연결 테스트(probe)와 시크릿 바인딩. 실패는 결과로 되돌린다(throw 아님):
// "이 도구가 나에게는 안 닿는다"가 사용자가 보러 온 답이므로 화면이 인라인으로 렌더한다.

export interface ProbeAgentToolResult {
  ok: boolean
  result?: AgentToolProbe
  error?: string
}

// 지금 이 순간 서버가 진짜 제공하는 function 목록 — 저자가 선언한 provides 와 대조할 수 있는 유일한 근거.
export async function probeAgentToolAction(key: string): Promise<ProbeAgentToolResult> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      result: agentToolProbeSchema.parse(await controlPlane.probeAgentTool(ctx, key)),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface BindAgentToolSecretsResult {
  ok: boolean
  tool?: AgentToolDetail
  error?: string
}

// 선언된 시크릿 이름 → 실제 시크릿 이름. 값은 오가지 않는다. 워크스페이스 AgentSpec 편집이라 새 에이전트 버전이 남는다.
export async function bindAgentToolSecretsAction(
  key: string,
  bindings: Record<string, string>
): Promise<BindAgentToolSecretsResult> {
  const ctx = await authContext()
  try {
    const tool = agentToolDetailSchema.parse(
      await controlPlane.bindAgentToolSecrets(ctx, key, bindings)
    )
    revalidatePath('/[workspace]/tools')
    revalidatePath('/[workspace]/tools/[key]')
    return { ok: true, tool }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
