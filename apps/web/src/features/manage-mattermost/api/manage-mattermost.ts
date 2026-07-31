'use server'

import { revalidatePath } from 'next/cache'

import { mattermostProbeResultSchema, type MattermostProbe } from '@/entities/mattermost'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface MattermostMutationResult {
  ok: boolean
  error?: string
}

export interface MattermostProbeResult {
  ok: boolean
  error?: string
  probe?: MattermostProbe
}

// Register/update ONE Mattermost connection (admin, upsert by name — a workspace registers one bot + channel per
// team/purpose). The server URL is operator env (MATTERMOST_HOST), not passed here. Put the bot token (value) into a
// workspace secret first and specify only its name. The control plane verifies the bot token (+ channel) against the
// live server before saving (strict). authZ (settings:write) is enforced by the control plane.
export async function setMattermostAction(input: {
  name: string
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

// Test connection (admin) — verify the bot token (+ optional channel) against the operator server before saving.
// A classified failure is a successful call with reachable=false; a config/permission failure surfaces as error.
export async function probeMattermostAction(input: {
  botTokenSecretName: string
  defaultChannelId?: string
}): Promise<MattermostProbeResult> {
  const ctx = await authContext()
  try {
    const probe = mattermostProbeResultSchema.parse(await controlPlane.probeMattermost(ctx, input))
    return { ok: true, probe }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Remove one Mattermost connection (admin, by name). Its channel stops receiving completion/regression
// notifications; the workspace's other connections keep posting.
export async function removeMattermostAction(name: string): Promise<MattermostMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeMattermost(ctx, name)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
