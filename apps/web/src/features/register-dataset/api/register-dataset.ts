'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

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

// dry-run 검증: 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음). authZ/검증은 컨트롤플레인이 강제.
export async function validateDatasetAction(dataset: unknown): Promise<ValidateDatasetResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateDataset<ValidateDatasetResult>(ctx, dataset)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 등록(커밋). 스키마 검증/불변성(409)/authZ(member+)은 컨트롤플레인이 강제한다.
export async function createDatasetAction(dataset: unknown): Promise<CreateDatasetResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.createDataset<{ id: string; version: string }>(ctx, dataset)
    revalidatePath('/[workspace]/datasets')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
