'use server'

import { revalidatePath } from 'next/cache'
import { getTranslations } from 'next-intl/server'

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

// Server action: upload externally-run traces (TraceEvent[]) as a scorecard. The validation/normalization contract is enforced by the control plane.
// tracesJson is [{caseId, trace, snapshot?, scores?}] shape. Parse/schema errors are 400 from the control plane.
export async function ingestScorecardAction(
  input: IngestScorecardInput
): Promise<IngestScorecardResult> {
  const ctx = await authContext()
  const t = await getTranslations('ingestScorecard')
  let traces: unknown
  try {
    traces = JSON.parse(input.tracesJson)
  } catch {
    return { ok: false, error: t('tracesParseError') }
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
  sourceKind: 'otel' | 'mlflow' | 'langfuse' | 'langsmith' | 'phoenix'
  endpoint: string
  authSecret: string
  sourceProject?: string // phoenix-only — the project name/ID in the span lookup path
  runsJson: string
}

// Server action: pull mode — pull traces by runId from the tenant's OTel/MLflow into a scorecard. Credentials are the authSecret name (SecretStore).
// runsJson is [{caseId, runId}] shape. Parse failure is 400 here; schema/network errors are handled by the control plane.
export async function pullScorecardAction(
  input: PullScorecardInput
): Promise<IngestScorecardResult> {
  const ctx = await authContext()
  const t = await getTranslations('ingestScorecard')
  let runs: unknown
  try {
    runs = JSON.parse(input.runsJson)
  } catch {
    return { ok: false, error: t('runsParseError') }
  }
  const body = {
    dataset: { id: input.datasetId, version: input.datasetVersion || 'latest' },
    harness: { id: input.harnessId, version: input.harnessVersion || 'latest' },
    source: {
      kind: input.sourceKind,
      endpoint: input.endpoint,
      ...(input.authSecret ? { authSecret: input.authSecret } : {}),
      ...(input.sourceProject ? { project: input.sourceProject } : {}),
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
