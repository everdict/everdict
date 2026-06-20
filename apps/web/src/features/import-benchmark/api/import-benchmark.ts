'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ImportBenchmarkResult {
  ok: boolean
  id?: string
  version?: string
  cases?: number
  error?: string
}

// 카탈로그 벤치마크를 당겨 이 워크스페이스의 데이터셋으로 등록. authZ(member+)·HF 인출·불변성(409)은 컨트롤플레인이 강제.
export async function importBenchmarkAction(body: unknown): Promise<ImportBenchmarkResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.importBenchmark<{ id: string; version: string; cases: number }>(
      ctx,
      body
    )
    revalidatePath('/dashboard/datasets')
    revalidatePath('/dashboard')
    return { ok: true, id: rec.id, version: rec.version, cases: rec.cases }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
