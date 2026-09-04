'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface VerifySkillResult {
  ok: boolean
  error?: string
}

// Server action: attest that a skill still holds. A skill is guidance somebody wrote against a codebase
// that keeps moving, so "it was true when written" is the default and re-attesting is how that stops being
// the only thing anyone can say about it.
export async function verifySkillAction(id: string): Promise<VerifySkillResult> {
  const ctx = await authContext()
  try {
    await controlPlane.verifySkill(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
