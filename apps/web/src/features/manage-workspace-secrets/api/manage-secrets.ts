'use server'

import { revalidatePath } from 'next/cache'
import { getTranslations } from 'next-intl/server'

import { secretMetaSchema, type SecretMeta, type SecretScope } from '@/entities/secret'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SecretMutationResult {
  ok: boolean
  error?: string
}

// The registration input for an offline-token secret (a long-lived OAuth refresh token + the token endpoint it's
// minted against). The refresh/access tokens never come back — only the resulting metadata (incl. the computed expiry).
export interface OfflineTokenGrantInput {
  tokenUrl: string
  clientId: string
  clientSecret?: string
  refreshToken: string
  scope?: string
}

export interface OfflineTokenMutationResult extends SecretMutationResult {
  meta?: SecretMeta
}

// env-format name (same as the control plane's SecretNameSchema) — first-pass validation at the form; final enforcement is the control plane.
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

// Revalidate after a per-scope change — user (personal) = the account personal-secrets page, workspace (shared) = the workspace secrets page.
function revalidateFor(scope: SecretScope): void {
  revalidatePath(
    scope === 'user' ? '/[workspace]/settings/personal-secrets' : '/[workspace]/settings/secrets'
  )
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

// Register/replace an offline-token secret. The control plane validates the refresh token (one grant) + computes the
// first access-token expiry; thereafter any reference to this name injects a freshly-minted access token. authZ (admin
// for workspace scope) is enforced by the control plane. Returns the metadata (with expiry) so the UI can confirm it.
export async function setOfflineTokenAction(
  name: string,
  grant: OfflineTokenGrantInput,
  scope: SecretScope
): Promise<OfflineTokenMutationResult> {
  const t = await getTranslations('manageWorkspaceSecrets')
  if (!NAME_RE.test(name)) return { ok: false, error: t('nameFormat') }
  if (grant.tokenUrl.length === 0 || grant.clientId.length === 0 || grant.refreshToken.length === 0)
    return { ok: false, error: t('offlineToken.fieldsRequired') }
  const ctx = await authContext()
  try {
    const raw = await controlPlane.setOfflineToken<unknown>(ctx, name, grant, scope)
    revalidateFor(scope)
    return { ok: true, meta: secretMetaSchema.parse(raw) }
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
