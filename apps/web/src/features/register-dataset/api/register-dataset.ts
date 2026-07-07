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
    revalidatePath('/[workspace]/datasets')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
