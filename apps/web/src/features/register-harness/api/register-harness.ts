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

// 인스턴스 등록(커밋). 템플릿 존재 + pins resolve / 불변성(409) 은 컨트롤플레인이 강제(무게이트 viewer+).
export async function registerHarnessAction(instance: unknown): Promise<RegisterHarnessResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.registerHarness<{ id: string; version: string }>(ctx, instance)
    revalidatePath('/[workspace]/harnesses')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 템플릿(대분류) dry-run 검증 — 스키마 + 기존 버전(등록하지 않음).
export async function validateHarnessTemplateAction(spec: unknown): Promise<ValidateHarnessResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateHarnessTemplate<ValidateHarnessResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 템플릿(대분류) 등록(커밋). 불변성(409)/검증은 컨트롤플레인이 강제(무게이트 viewer+).
export async function registerHarnessTemplateAction(spec: unknown): Promise<RegisterHarnessResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.registerHarnessTemplate<{ id: string; version: string }>(ctx, spec)
    revalidatePath('/[workspace]/harnesses')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
