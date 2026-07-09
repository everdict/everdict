'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface BudgetMutationResult {
  ok: boolean
  error?: string
}

// Replace this workspace's enforcement budget limit (admin). Each dimension is optional; an omitted dimension is
// unlimited (a PUT replaces the whole limit). authZ (settings:write) is enforced by the control plane.
export async function setBudgetLimitAction(input: {
  usd?: number
  tokens?: number
  runs?: number
}): Promise<BudgetMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setBudget(ctx, input)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
