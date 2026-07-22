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

export interface EvaluateTracesInput {
  sourceName: string // a REGISTERED workspace trace source (Settings › Observability) — pull by name (credential from the pool)
  traceIds: string[] // the selected trace ids to evaluate; each becomes one case (caseId = trace id)
  judgeIds: string[] // Agent Judges to score each pulled trace (empty = control-plane default scoring)
}

// Server action: the "evaluate existing traces" scorecard — pull a chosen SET of traces from a registered source and
// judge them directly, with NO dataset and NO harness run (each trace = one case). A thin wrapper over pull-ingest with
// dataset/harness omitted (the control plane stamps the trace-eval sentinel).
export async function evaluateTracesAction(
  input: EvaluateTracesInput
): Promise<IngestScorecardResult> {
  const ctx = await authContext()
  const t = await getTranslations('evaluateTraces')
  if (!input.sourceName) return { ok: false, error: t('noSource') }
  if (input.traceIds.length === 0) return { ok: false, error: t('noTraces') }
  const body = {
    // dataset + harness deliberately omitted → the control plane treats this as a direct trace evaluation.
    // correlate:"id" — the ids ARE the platform's real trace ids (from listTraces), so fetch by id even if the source
    // is registered for "tag" (everdict.run_id) correlation.
    source: { name: input.sourceName, correlate: 'id' as const },
    runs: input.traceIds.map((id) => ({ caseId: id, runId: id })),
    ...(input.judgeIds.length > 0
      ? { judges: input.judgeIds.map((id) => ({ id, version: 'latest' })) }
      : {}),
  }
  try {
    const rec = await controlPlane.ingestScorecardPull<{ id: string }>(ctx, body)
    revalidatePath('/[workspace]/scorecards')
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
