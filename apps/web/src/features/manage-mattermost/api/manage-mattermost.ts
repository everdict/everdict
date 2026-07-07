'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface MattermostMutationResult {
  ok: boolean
  error?: string
}

// Register/update the Mattermost integration (admin). Put the bot token (value) into a workspace secret first and specify only its name.
// authZ (admin = settings:write) is enforced by the control plane.
export async function setMattermostAction(input: {
  host: string
  botTokenSecretName: string
  defaultChannelId?: string
  commandTokenSecretName?: string
}): Promise<MattermostMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setMattermost(ctx, input)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Remove the Mattermost integration (admin). Completion/regression notifications are no longer posted afterward.
export async function removeMattermostAction(): Promise<MattermostMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeMattermost(ctx)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
