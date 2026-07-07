'use server'

import { revalidatePath } from 'next/cache'
import { getTranslations } from 'next-intl/server'

import type { SecretScope } from '@/entities/secret'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SecretMutationResult {
  ok: boolean
  error?: string
}

// env-format name (same as the control plane's SecretNameSchema) — first-pass validation at the form; final enforcement is the control plane.
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

// Revalidate after a per-scope change — user (personal) = account screen, workspace (shared) = workspace settings.
function revalidateFor(scope: SecretScope): void {
  revalidatePath(scope === 'user' ? '/[workspace]/account' : '/[workspace]/settings')
}

// Set/update a secret (encrypted at rest; the value is never shown again). scope = workspace (admin) | user (self). authZ is enforced by the control plane.
export async function setSecretAction(
  name: string,
  value: string,
  scope: SecretScope
): Promise<SecretMutationResult> {
  const t = await getTranslations('manageWorkspaceSecrets')
  if (!NAME_RE.test(name)) return { ok: false, error: t('nameFormat') }
  if (value.length === 0) return { ok: false, error: t('valueEmpty') }
  const ctx = await authContext()
  try {
    await controlPlane.setSecret(ctx, name, value, scope)
    revalidateFor(scope)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Delete a secret. scope selects the tier (shared/personal). authZ is enforced by the control plane.
export async function deleteSecretAction(
  name: string,
  scope: SecretScope
): Promise<SecretMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteSecret(ctx, name, scope)
    revalidateFor(scope)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
