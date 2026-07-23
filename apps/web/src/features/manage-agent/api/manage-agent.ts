'use server'

import { revalidatePath } from 'next/cache'

import { saveAgentResultSchema } from '@/entities/agent-spec'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SaveAgentActionResult {
  ok: boolean
  version?: string
  created?: boolean
  error?: string
}

// 워크스페이스 에이전트 저장(PUT /agents/:id) — 버전 없는 업서트. 새 id → 1.0.0, 스펙 변경 → patch 자동 증가(새 불변 버전),
// 동일 → 멱등 no-op. authZ(agents:write)/버전 배정은 컨트롤플레인이 담당. body = AgentSpec 에서 id/version 뺀 것.
export async function saveAgentAction(id: string, body: unknown): Promise<SaveAgentActionResult> {
  const ctx = await authContext()
  try {
    const r = saveAgentResultSchema.parse(await controlPlane.saveAgent(ctx, id, body))
    revalidatePath('/[workspace]/settings')
    return { ok: true, version: r.version, created: r.created }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
