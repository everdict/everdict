'use server'

import { revalidatePath } from 'next/cache'

import { createApiKeyInputSchema, createdApiKeySchema, type ApiKeyScope } from '@/entities/api-key'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface CreateKeyResult {
  ok: boolean
  apiKey?: string // plaintext (ak_…) — once only. Show it in the modal, then discard.
  error?: string
}

export interface RevokeKeyResult {
  ok: boolean
  error?: string
}

// Issue an API key. scopes can narrow permissions (unset = Full Access). authZ (admin = keys:write) is enforced by the control plane.
export async function createKeyAction(
  label?: string,
  scopes?: ApiKeyScope[]
): Promise<CreateKeyResult> {
  const ctx = await authContext()
  try {
    // Boundary validation (the control plane re-enforces it, but reject bad input here). Empty/unset scopes are not sent (= Full Access).
    const body = createApiKeyInputSchema.parse({
      label: label && label.length > 0 ? label : undefined,
      scopes: scopes && scopes.length > 0 ? scopes : undefined,
    })
    const res = createdApiKeySchema.parse(await controlPlane.createKey(ctx, body))
    revalidatePath('/[workspace]/settings/api-keys')
    return { ok: true, apiKey: res.apiKey }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Revoke an API key (invalidated immediately). authZ (admin = keys:write) is enforced by the control plane.
export async function revokeKeyAction(id: string): Promise<RevokeKeyResult> {
  const ctx = await authContext()
  try {
    await controlPlane.revokeKey(ctx, id)
    revalidatePath('/[workspace]/settings/api-keys')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
