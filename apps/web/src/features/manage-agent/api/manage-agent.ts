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

// Saving the workspace agent (PUT /agents/:id) — a versionless upsert. A new id → 1.0.0, a changed spec → an automatic patch bump (a new immutable version),
// identical → an idempotent no-op. AuthZ (agents:write) and version assignment are the control plane's. The body = the AgentSpec minus id/version.
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
