'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Control plane /rubrics/validate response (loose mirror). ok=false → show errors (schema).

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
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
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
