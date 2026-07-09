'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Control plane /judges/validate response (loose mirror). ok=false → show errors (schema).
export interface ValidateJudgeResult {
  ok: boolean
  errors?: string[]
  existingVersions?: string[]
  versionExists?: boolean
  id?: string
  version?: string
  kind?: string
  error?: string
}

// dry-run validation: schema + this workspace's existing versions/conflict (does not register).
// authZ/validation are enforced by the control plane; on transport failure return {ok:false} so the form stays alive.
export async function validateJudgeAction(spec: unknown): Promise<ValidateJudgeResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateJudge<ValidateJudgeResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface CreateJudgeResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

// Register (POST /judges). Schema validation / immutability (409) / authZ (judges:write, member+) are the control plane's.
export async function createJudgeAction(spec: unknown): Promise<CreateJudgeResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.createJudge<{ id: string; version: string }>(ctx, spec)
    revalidatePath('/[workspace]/judges')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
