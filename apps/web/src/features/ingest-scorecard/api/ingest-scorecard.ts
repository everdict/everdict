'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface IngestScorecardInput {
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  judgeIds: string[]
  tracesJson: string
}

export interface IngestScorecardResult {
  ok: boolean
  id?: string
  error?: string
}

// 서버 액션: 외부에서 이미 수행한 트레이스(TraceEvent[])를 올려 scorecard 로. 검증/정규화 계약은 컨트롤플레인이 강제.
// tracesJson 은 [{caseId, trace, snapshot?, scores?}] 형태. 파싱 실패/스키마 오류는 컨트롤플레인이 400.
export async function ingestScorecardAction(input: IngestScorecardInput): Promise<IngestScorecardResult> {
  const ctx = await authContext()
  let traces: unknown
  try {
    traces = JSON.parse(input.tracesJson)
  } catch {
    return { ok: false, error: 'traces JSON 파싱 실패' }
  }
  const body = {
    dataset: { id: input.datasetId, version: input.datasetVersion || 'latest' },
    harness: { id: input.harnessId, version: input.harnessVersion || 'latest' },
    traces,
    judges: input.judgeIds.map((id) => ({ id, version: 'latest' })),
  }
  try {
    const rec = await controlPlane.ingestScorecard<{ id: string }>(ctx, body)
    revalidatePath('/dashboard/scorecards')
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
