'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Control plane /runtimes/validate response (loose mirror). When ok=false, show errors (schema).
export interface ValidateRuntimeResult {
  ok: boolean
  errors?: string[]
  versionExists?: boolean
  referenced?: string[]
  missingSecrets?: string[]
  error?: string
}

// Schema validation + version-conflict / referenced-secret check (doesn't run a job). On failure returns {ok:false} so the form stays alive.
export async function validateRuntimeAction(spec: unknown): Promise<ValidateRuntimeResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateRuntime<ValidateRuntimeResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Live connection test — connects to the real cluster/daemon to check only reachability and auth (doesn't run a job).
export interface ProbeRuntimeResult {
  ok: boolean
  reachable?: boolean
  detail?: string
  error?: string
}

export async function probeRuntimeAction(spec: unknown): Promise<ProbeRuntimeResult> {
  const ctx = await authContext()
  try {
    const r = await controlPlane.probeRuntime<{ reachable: boolean; detail?: string }>(ctx, spec)
    return { ok: true, reachable: r.reachable, detail: r.detail }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface CreateRuntimeResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

// Register (POST /runtimes). authZ (runtimes:write) is enforced by the control plane. Versions are immutable, so the server blocks re-registering the same version.
export async function createRuntimeAction(spec: unknown): Promise<CreateRuntimeResult> {
  const ctx = await authContext()
  try {
    const r = await controlPlane.createRuntime<{ id: string; version: string }>(ctx, spec)
    revalidatePath('/[workspace]/runtimes')
    revalidatePath('/[workspace]')
    return { ok: true, id: r.id, version: r.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
