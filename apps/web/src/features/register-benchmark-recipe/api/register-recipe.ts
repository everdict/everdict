'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface RegisterRecipeResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

export interface ValidateRecipeResult {
  ok: boolean
  id?: string
  version?: string
  source?: string
  graderTemplates?: number
  existingVersions?: string[]
  versionExists?: boolean
  errors?: string[]
  error?: string
}

// dry-run 검증: 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음).
export async function validateRecipeAction(spec: unknown): Promise<ValidateRecipeResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateBenchmarkRecipe<ValidateRecipeResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 벤치마크 레시피(BenchmarkAdapterSpec) 등록. 스키마 검증/불변성(409)/authZ(member+)은 컨트롤플레인이 강제.
export async function registerRecipeAction(spec: unknown): Promise<RegisterRecipeResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.registerBenchmarkRecipe<{ id: string; version: string }>(
      ctx,
      spec
    )
    revalidatePath('/dashboard/datasets/recipes')
    revalidatePath('/dashboard/datasets/import')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
