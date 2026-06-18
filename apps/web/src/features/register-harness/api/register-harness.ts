'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ValidateHarnessResult {
  ok: boolean
  errors?: string[]
  existingVersions?: string[]
  versionExists?: boolean
  id?: string
  version?: string
  kind?: string
  error?: string
}

export interface RegisterHarnessResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

// dry-run 검증: 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음). authZ/검증은 컨트롤플레인이 강제.
export async function validateHarnessAction(spec: unknown): Promise<ValidateHarnessResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateHarness<ValidateHarnessResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 등록(커밋). 스펙 검증/불변성(409)/authZ(admin)은 컨트롤플레인이 강제한다.
export async function registerHarnessAction(spec: unknown): Promise<RegisterHarnessResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.registerHarness<{ id: string; version: string }>(ctx, spec)
    revalidatePath('/dashboard/harnesses')
    revalidatePath('/dashboard')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
