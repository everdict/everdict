'use server'

import { revalidatePath } from 'next/cache'

import {
  adoptedEnvironmentSchema,
  adoptedEnvironmentsResponseSchema,
  type AdoptedEnvironment,
} from '@/entities/environment-adoption'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Workspace environment-image adoption ("import") — bring an environment into the workspace inventory with a
// pull-usability verification (warn-not-block). authZ (capabilities:read / settings:write) is control-plane enforced.
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function listAdoptedEnvironmentsAction(): Promise<
  { ok: true; environments: AdoptedEnvironment[] } | { ok: false; error: string }
> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.listAdoptedEnvironments(ctx)
    return { ok: true, environments: adoptedEnvironmentsResponseSchema.parse(raw).environments }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}

export async function adoptEnvironmentAction(ref: {
  source: string
  id: string
  version: string
}): Promise<{ ok: true; environment: AdoptedEnvironment } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.adoptEnvironment(ctx, ref)
    revalidatePath('/[workspace]/store')
    return { ok: true, environment: adoptedEnvironmentSchema.parse(raw) }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}

export async function verifyAdoptedEnvironmentAction(
  source: string,
  id: string
): Promise<{ ok: true; environment: AdoptedEnvironment } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.verifyAdoptedEnvironment(ctx, { source, id })
    revalidatePath('/[workspace]/store')
    return { ok: true, environment: adoptedEnvironmentSchema.parse(raw) }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}

export async function unadoptEnvironmentAction(
  source: string,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.unadoptEnvironment(ctx, source, id)
    revalidatePath('/[workspace]/store')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}
