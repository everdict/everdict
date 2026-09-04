'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SetAgentSkillResult {
  ok: boolean
  error?: string
}

// The on/off for a skill my agent follows — it leaves the workspace library untouched and changes only MY overlay.
// enabled=null clears the override (following the workspace default). The control plane enforces the self scope.
export async function setAgentSkillAction(
  key: string,
  enabled: boolean | null
): Promise<SetAgentSkillResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setAgentSkill(ctx, key, enabled)
    revalidatePath('/[workspace]/skills')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
