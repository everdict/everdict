'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SetAgentToolResult {
  ok: boolean
  error?: string
}

// My agent's tool on/off — it leaves the workspace AgentSpec untouched and changes only MY overlay.
// enabled=null clears the override (following the workspace default). The control plane enforces the self scope.
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
