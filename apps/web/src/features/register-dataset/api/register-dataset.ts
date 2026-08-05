'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface ValidateDatasetResult {
  ok: boolean
  errors?: string[]
  existingVersions?: string[]
  versionExists?: boolean
  id?: string
  version?: string
  cases?: number
  error?: string
}

export interface CreateDatasetResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

// dry-run validation: schema + this workspace's existing versions/conflicts (does not register). authZ/validation are enforced by the control plane.
export async function validateDatasetAction(dataset: unknown): Promise<ValidateDatasetResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateDataset<ValidateDatasetResult>(ctx, dataset)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Register (commit). Schema validation / immutability (409) / authZ (member+) are enforced by the control plane.
export async function createDatasetAction(dataset: unknown): Promise<CreateDatasetResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.createDataset<{ id: string; version: string }>(ctx, dataset)
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
