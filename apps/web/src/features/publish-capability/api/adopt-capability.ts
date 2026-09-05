'use server'

import { agentSpecSchema, type AgentSpec, type CapabilityRef } from '@/entities/agent-spec'
import { authContext } from '@/shared/auth/principal'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

// The workspace's default agent id — the same as apps/agent's AGENT_CONFIG_ID ('default') and the Settings › Agent page.
const AGENT_CONFIG_ID = 'default'

async function loadAgent(ctx: AuthContext): Promise<AgentSpec | undefined> {
  try {
    return agentSpecSchema.parse(await controlPlane.getAgent(ctx, AGENT_CONFIG_ID, 'latest'))
  } catch {
    return undefined // no agent registered yet → start from an empty customization.
  }
}

// AgentSpec → the save body (id/version excluded). Only `capabilities` is replaced; every other customization is preserved.
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

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the DECLARATION
// alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface AdoptActionResult {
  ok: boolean
  error?: string
}

// Adopt — add a store capability to my agent (an immutable version pin). The same (source,id) is REPLACED (a re-pin or a binding update), and added when absent.
// AgentSpec.capabilities is updated read-modify-write (PUT /agents/:id, a versionless upsert). AuthZ (agents:write) is the control plane's.
export async function adoptCapabilityAction(ref: CapabilityRef): Promise<AdoptActionResult> {
  const ctx = await authContext()
  try {
    const agent = await loadAgent(ctx)
    const existing = agent?.capabilities ?? []
    const next = [...existing.filter((c) => !(c.source === ref.source && c.id === ref.id)), ref]
    await controlPlane.saveAgent(ctx, AGENT_CONFIG_ID, toSaveBody(agent, next))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Un-adopt — remove this capability reference from my agent.
export async function unadoptCapabilityAction(
  source: string,
  id: string
): Promise<AdoptActionResult> {
  const ctx = await authContext()
  try {
    const agent = await loadAgent(ctx)
    const next = (agent?.capabilities ?? []).filter((c) => !(c.source === source && c.id === id))
    await controlPlane.saveAgent(ctx, AGENT_CONFIG_ID, toSaveBody(agent, next))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
