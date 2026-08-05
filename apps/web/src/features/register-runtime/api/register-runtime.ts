'use server'

import {
  runtimeControlResultSchema,
  runtimeInspectionSchema,
  type RuntimeControlCommand,
  type RuntimeControlResult,
  type RuntimeInspection,
} from '@/entities/runtime'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Control plane /runtimes/validate response (loose mirror). When ok=false, show errors (schema).

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
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

// Live cluster view of a REGISTERED runtime (by id/version) — nodes/capacity/workload/stores, no job. Read gate
// (runtimes:read) is the control plane's; a partial-cluster failure comes back inside inspection.warnings, not here.
export interface InspectRuntimeActionResult {
  ok: boolean
  inspection?: RuntimeInspection
  error?: string
}

export async function inspectRuntimeAction(
  id: string,
  version: string
): Promise<InspectRuntimeActionResult> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.inspectRuntime<unknown>(ctx, id, version)
    return { ok: true, inspection: runtimeInspectionSchema.parse(raw) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Destructive live-cluster control (admin, runtimes:control) — stop/reclaim/purge/cordon. authZ is the control plane's.
export interface ControlRuntimeActionResult {
  ok: boolean
  result?: RuntimeControlResult
  error?: string
}

export async function controlRuntimeAction(
  id: string,
  version: string,
  command: RuntimeControlCommand
): Promise<ControlRuntimeActionResult> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.controlRuntime<unknown>(ctx, id, version, command)
    return { ok: true, result: runtimeControlResultSchema.parse(raw) }
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
    return { ok: true, id: r.id, version: r.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
