'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Control plane /judges/validate response (loose mirror). ok=false → show errors (schema).
export interface ValidateJudgeResult {
  ok: boolean
  errors?: string[]
  existingVersions?: string[]
  versionExists?: boolean
  id?: string
  version?: string
  kind?: string
  error?: string
}

// dry-run validation: schema + this workspace's existing versions/conflict (does not register).
// authZ/validation are enforced by the control plane; on transport failure return {ok:false} so the form stays alive.
export async function validateJudgeAction(spec: unknown): Promise<ValidateJudgeResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateJudge<ValidateJudgeResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Control plane /judges/preview response (loose mirror). No model call — renders the exact prompt + coverage.
export interface EvidenceCoverage {
  present: boolean
  chars: number
  truncated: boolean
}
export interface EvidenceRequirement {
  kind: string
  name?: string
  role?: string
}
export interface PreviewJudgeResult {
  ok: boolean
  kind?: 'model' | 'harness'
  prompt?: string
  evidence?: Record<string, EvidenceCoverage>
  warnings?: string[]
  requirements?: {
    satisfied: EvidenceRequirement[]
    missing: EvidenceRequirement[]
    warnings: string[]
  }
  error?: string
}

// One judge score (loose mirror of the control plane's Score).
export interface JudgeScore {
  graderId: string
  metric: string
  value: number
  pass?: boolean
  detail?: unknown
}
export interface TryJudgeResult extends PreviewJudgeResult {
  scores?: JudgeScore[]
  // code judge — the dry-run is promoted to a REAL standalone run; poll it (judgeTryRunAction) for progress/verdict.
  runId?: string
}

// Dry-run a draft judge — ACTUALLY runs it (one case) over a pasted trace. model judges return the real scores
// inline; a code judge returns the runId of its promoted run. A missing key/unresolved rubric surfaces as a skip
// score with a reason.
export async function tryJudgeAction(
  spec: unknown,
  trace: unknown,
  meta?: { task?: string; expected?: string; snapshot?: unknown; traceEvidence?: unknown }
): Promise<TryJudgeResult> {
  const ctx = await authContext()
  try {
    const evidence = {
      source: 'trace' as const,
      trace,
      ...(meta?.task ? { task: meta.task } : {}),
      ...(meta?.expected ? { expected: meta.expected } : {}),
      ...(meta?.snapshot ? { snapshot: meta.snapshot } : {}),
      ...(meta?.traceEvidence ? { traceEvidence: meta.traceEvidence } : {}),
    }
    const r = await controlPlane.tryJudge<Omit<TryJudgeResult, 'ok'>>(ctx, { spec, evidence })
    return { ok: true, ...r }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// One poll of the promoted code-judge run (loose mirror of GET /runs/:id + the stderr log tail).
export interface JudgeTryRunState {
  ok: boolean
  status?: 'queued' | 'running' | 'succeeded' | 'failed'
  scores?: JudgeScore[]
  failure?: string // run error message (dispatch/sandbox failure — distinct from a failing verdict)
  logs?: string // live stderr tail while the wrapper job runs (best-effort)
  error?: string // transport error (the poll itself failed)
}

// Poll the code dry-run's promoted run: status transition, live stderr tail, and — once terminal — the verdict
// scores exactly as they landed on the run record (the panel stamps the judge:<id> metric prefix for display).
export async function judgeTryRunAction(runId: string): Promise<JudgeTryRunState> {
  const ctx = await authContext()
  try {
    const run = await controlPlane.getRun<{
      status: 'queued' | 'running' | 'succeeded' | 'failed'
      result?: { scores?: JudgeScore[] }
      error?: { code: string; message: string }
    }>(ctx, runId)
    const state: JudgeTryRunState = { ok: true, status: run.status }
    if (run.status === 'succeeded') state.scores = run.result?.scores ?? []
    if (run.status === 'failed' && run.error) state.failure = run.error.message
    // stderr carries the wrapper job's progress while it's live (and the crash context after a failure).
    if (run.status === 'running' || run.status === 'failed') {
      const logs = await controlPlane
        .getRunLogs<{ text?: string }>(ctx, runId, 'stderr')
        .catch(() => undefined)
      if (logs?.text) state.logs = logs.text
    }
    return state
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface CreateJudgeResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

// Register (POST /judges). Schema validation / immutability (409) / authZ (judges:write, member+) are the control plane's.
export async function createJudgeAction(spec: unknown): Promise<CreateJudgeResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.createJudge<{ id: string; version: string }>(ctx, spec)
    revalidatePath('/[workspace]/judges')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
