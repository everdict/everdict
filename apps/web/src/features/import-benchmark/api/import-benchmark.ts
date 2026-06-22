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

// 카탈로그/레시피/인라인 spec 을 당겨 이 워크스페이스의 데이터셋으로 등록. authZ(member+)·HF 인출·불변성(409)은 컨트롤플레인이 강제.
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

export interface PreviewSourceResult {
  ok: boolean
  fields?: string[]
  rows?: Record<string, unknown>[]
  error?: string
}

// 소스 미리보기 — 매핑 전 원본 행 + 감지된 필드. 위저드가 필드를 드롭다운에 채우고 매핑하기 전에 호출.
export async function previewSourceAction(body: unknown): Promise<PreviewSourceResult> {
  const ctx = await authContext()
  try {
    const r = await controlPlane.previewBenchmarkSource<{
      fields: string[]
      rows: Record<string, unknown>[]
    }>(ctx, body)
    return { ok: true, fields: r.fields, rows: r.rows }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
