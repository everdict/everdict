'use server'

import { getTranslations } from 'next-intl/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Same as the control plane's SecretNameSchema (env format) — first-pass form validation; final enforcement is the control plane.
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

export interface CreateSecretResult {
  ok: boolean
  error?: string
}

// Create/update inline from a secret-reference input (harness env · GHE App private key · Mattermost token, etc.)
// (encrypted at rest, never shown again). scope: "user" (my personal, self) | "workspace" (shared, admin).
// authZ is enforced by the control plane — error if unauthorized.
export async function createSecretAction(
  name: string,
  value: string,
  scope: 'user' | 'workspace'
): Promise<CreateSecretResult> {
  const t = await getTranslations('pickSecret')
  if (!NAME_RE.test(name)) return { ok: false, error: t('nameInvalidServer') }
  if (value.length === 0) return { ok: false, error: t('valueEmpty') }
  const ctx = await authContext()
  try {
    await controlPlane.setSecret(ctx, name, value, scope)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
