'use server'

import { revalidatePath } from 'next/cache'

import { agentSpecSchema, type AgentSpec, type CapabilityRef } from '@/entities/agent-spec'
import { authContext } from '@/shared/auth/principal'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

// 워크스페이스 기본 에이전트 id — apps/agent 의 AGENT_CONFIG_ID('default') 및 Settings › Agent 페이지와 동일.
const AGENT_CONFIG_ID = 'default'

async function loadAgent(ctx: AuthContext): Promise<AgentSpec | undefined> {
  try {
    return agentSpecSchema.parse(await controlPlane.getAgent(ctx, AGENT_CONFIG_ID, 'latest'))
  } catch {
    return undefined // 아직 등록된 에이전트 없음 → 빈 커스터마이즈에서 시작.
  }
}

// AgentSpec → 저장 바디(id/version 제외). capabilities 만 교체하고 나머지 커스터마이즈는 보존.
function toSaveBody(agent: AgentSpec | undefined, capabilities: CapabilityRef[]) {
  return {
    ...(agent?.instructions !== undefined ? { instructions: agent.instructions } : {}),
    ...(agent?.description !== undefined ? { description: agent.description } : {}),
    mcpServers: agent?.mcpServers ?? [],
    capabilities,
    ...(agent?.model !== undefined ? { model: agent.model } : {}),
    tags: agent?.tags ?? [],
  }
}

// 채택 상태를 렌더하는 표면 — 스토어(카탈로그·내 발행·상세)와 설정(에이전트의 채택 목록 + 관리 페이지들).
function revalidateAdoptionPages(): void {
  for (const path of [
    '/[workspace]/store',
    '/[workspace]/store/mine',
    '/[workspace]/settings',
    '/[workspace]/settings/agent',
    '/[workspace]/tools',
  ])
    revalidatePath(path)
  // 추가/제거를 실제로 누르는 자리 — 동적 세그먼트라 'page' 타입으로 지정해야 매칭된다.
  revalidatePath('/[workspace]/store/[source]/[id]', 'page')
}

export interface AdoptActionResult {
  ok: boolean
  error?: string
}

// 채택 — 스토어 capability 를 내 에이전트에 추가(불변버전 pin). 같은 (source,id)는 교체(재-pin/바인딩 갱신), 없으면 추가.
// AgentSpec.capabilities 를 read-modify-write 로 갱신(PUT /agents/:id 버전 없는 업서트). authZ(agents:write)는 컨트롤플레인.
export async function adoptCapabilityAction(ref: CapabilityRef): Promise<AdoptActionResult> {
  const ctx = await authContext()
  try {
    const agent = await loadAgent(ctx)
    const existing = agent?.capabilities ?? []
    const next = [...existing.filter((c) => !(c.source === ref.source && c.id === ref.id)), ref]
    await controlPlane.saveAgent(ctx, AGENT_CONFIG_ID, toSaveBody(agent, next))
    revalidateAdoptionPages()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 채택 해제 — 내 에이전트에서 이 capability 참조를 제거.
export async function unadoptCapabilityAction(
  source: string,
  id: string
): Promise<AdoptActionResult> {
  const ctx = await authContext()
  try {
    const agent = await loadAgent(ctx)
    const next = (agent?.capabilities ?? []).filter((c) => !(c.source === source && c.id === id))
    await controlPlane.saveAgent(ctx, AGENT_CONFIG_ID, toSaveBody(agent, next))
    revalidateAdoptionPages()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
