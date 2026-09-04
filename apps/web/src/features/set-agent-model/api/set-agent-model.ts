'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SetAgentModelResult {
  ok: boolean
  error?: string
}

// The default LLM for MY conversations — it leaves the workspace AgentSpec (the one an admin chose for everyone) untouched and changes only MY overlay.
// model=null clears the selection (= follow the workspace default). An unregistered model id is refused by the control plane with a 404.
export async function setAgentModelAction(model: string | null): Promise<SetAgentModelResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setAgentModel(ctx, model)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
