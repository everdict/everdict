'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface IngestScorecardInput {
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  tracesJson: string
}

export interface IngestScorecardResult {
  ok: boolean
  id?: string
  error?: string
}

// 서버 액션: 외부에서 이미 수행한 트레이스(TraceEvent[])를 올려 scorecard 로. 검증/정규화 계약은 컨트롤플레인이 강제.
// tracesJson 은 [{caseId, trace, snapshot?, scores?}] 형태. 파싱 실패/스키마 오류는 컨트롤플레인이 400.
export async function ingestScorecardAction(
  input: IngestScorecardInput
): Promise<IngestScorecardResult> {
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
  }
  try {
    const rec = await controlPlane.ingestScorecard<{ id: string }>(ctx, body)
    revalidatePath('/[workspace]/scorecards')
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface PullScorecardInput {
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  sourceKind: 'otel' | 'mlflow'
  endpoint: string
  authSecret: string
  runsJson: string
}

// 서버 액션: pull 모드 — 테넌트 OTel/MLflow 에서 runId 별 트레이스를 당겨와 scorecard 로. 자격증명은 authSecret 이름(SecretStore).
// runsJson 은 [{caseId, runId}] 형태. 파싱 실패는 여기서 400, 스키마/네트워크 오류는 컨트롤플레인이 처리.
export async function pullScorecardAction(
  input: PullScorecardInput
): Promise<IngestScorecardResult> {
  const ctx = await authContext()
  let runs: unknown
  try {
    runs = JSON.parse(input.runsJson)
  } catch {
    return { ok: false, error: 'runs JSON 파싱 실패' }
  }
  const body = {
    dataset: { id: input.datasetId, version: input.datasetVersion || 'latest' },
    harness: { id: input.harnessId, version: input.harnessVersion || 'latest' },
    source: {
      kind: input.sourceKind,
      endpoint: input.endpoint,
      ...(input.authSecret ? { authSecret: input.authSecret } : {}),
    },
    runs,
  }
  try {
    const rec = await controlPlane.ingestScorecardPull<{ id: string }>(ctx, body)
    revalidatePath('/[workspace]/scorecards')
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
