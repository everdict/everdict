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

// The surfaces that render environment inventory and imported state — the store (the catalog, my publications, the detail) and the settings Environments page.
function revalidateEnvironmentPages(): void {
  for (const path of [
    '/[workspace]/store',
    '/[workspace]/store/mine',
    '/[workspace]/settings/environments',
  ])
    revalidatePath(path)
  // Where import/remove and re-verify are pressed — it is a dynamic segment, so it has to be declared as the 'page' type to match.
  revalidatePath('/[workspace]/store/[source]/[id]', 'page')
}

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
    revalidateEnvironmentPages()
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
    revalidateEnvironmentPages()
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
    revalidateEnvironmentPages()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}
