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
    revalidatePath('/[workspace]/datasets')
    revalidatePath('/[workspace]')
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

export interface HfDatasetHit {
  id: string
  likes: number
  gated: boolean
}
export interface HfSplit {
  config: string
  split: string
}

// HF Hub 검색 — 검색어로 데이터셋 후보를 찾는다(정확한 id 직접 입력 회피).
export async function searchHfDatasetsAction(
  query: string,
  limit?: number
): Promise<{ ok: boolean; hits?: HfDatasetHit[]; error?: string }> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      hits: await controlPlane.searchHfDatasets<HfDatasetHit[]>(ctx, query, limit),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 선택한 HF 데이터셋의 config/split 조합 — 드롭다운용.
export async function hfSplitsAction(
  dataset: string
): Promise<{ ok: boolean; splits?: HfSplit[]; error?: string }> {
  const ctx = await authContext()
  try {
    return { ok: true, splits: await controlPlane.hfDatasetSplits<HfSplit[]>(ctx, dataset) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// repo 데이터 파일(csv/jsonl/json) 목록 — 뷰어(datasets-server) 미서빙 데이터셋의 파일 직접 인출 폴백.
export async function hfFilesAction(
  dataset: string
): Promise<{ ok: boolean; files?: string[]; error?: string }> {
  const ctx = await authContext()
  try {
    return { ok: true, files: await controlPlane.hfDatasetFiles<string[]>(ctx, dataset) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
