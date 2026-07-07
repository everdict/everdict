'use server'

import { revalidatePath } from 'next/cache'

import { imageRegistrySetResponseSchema } from '@/entities/image-registry'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ImageRegistryMutationResult {
  ok: boolean
  error?: string
  missingSecrets?: string[] // referenced-secret-absent warning (warn-not-block) — the save succeeded, just add the secret later
}

// Register/update image registry (admin, upsert keyed by name). Put the pull/push token (value) in a workspace secret
// first and specify only its name. authZ (admin = settings:write) is enforced by the control plane.
export async function upsertImageRegistryAction(input: {
  name: string
  host: string
  namespace?: string
  username?: string
  pullSecretName?: string
  pushSecretName?: string
}): Promise<ImageRegistryMutationResult> {
  const ctx = await authContext()
  try {
    const r = imageRegistrySetResponseSchema.parse(
      await controlPlane.upsertImageRegistry(ctx, input)
    )
    revalidatePath('/[workspace]/settings')
    return { ok: true, ...(r.missingSecrets ? { missingSecrets: r.missingSecrets } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Delete image registry (admin). Afterward, classification no longer yields that registry's workspace class.
export async function removeImageRegistryAction(
  name: string
): Promise<ImageRegistryMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeImageRegistry(ctx, name)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
