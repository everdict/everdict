'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Control plane /rubrics/validate response (loose mirror). ok=false → show errors (schema).
export interface ValidateRubricResult {
  ok: boolean
  errors?: string[]
  existingVersions?: string[]
  versionExists?: boolean
  id?: string
  version?: string
  error?: string
}

// dry-run validation: schema + this workspace's existing versions/conflict (does not register).
// authZ/validation are enforced by the control plane; on transport failure return {ok:false} so the form stays alive.
export async function validateRubricAction(spec: unknown): Promise<ValidateRubricResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateRubric<ValidateRubricResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface CreateRubricResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

// Register (POST /rubrics). Schema validation / immutability (409) / authZ (judges:write, member+) are the control plane's.
export async function createRubricAction(spec: unknown): Promise<CreateRubricResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.createRubric<{ id: string; version: string }>(ctx, spec)
    revalidatePath('/[workspace]/rubrics')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
