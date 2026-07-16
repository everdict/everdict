'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SubmitRunInput {
  harnessId: string
  version: string
  task: string
  // Tenant Runtime id to run on (placement.target). Empty string means the default backend. self:<id> = my local runner.
  runtime?: string
  // repo seed: 'files' (empty working tree, default) | 'git' (remote repo). git requires gitUrl. For private repos, if the workspace
  // GitHub App is installed on that repo the control plane clones with automatic auth (no connection selection at submit time).
  sourceKind?: 'files' | 'git'
  gitUrl?: string
  gitRef?: string
  // Per-run wall-clock budget in seconds. Omitted → the control plane applies the EvalCase default (1800s).
  timeoutSec?: number
}
export interface SubmitRunResult {
  ok: boolean
  id?: string
  error?: string
}

// Build the repo seed source from input. For git, private repos are authenticated automatically by the workspace GitHub App at dispatch time (no submit input).
function repoSource(
  input: SubmitRunInput
): { files: Record<string, string> } | { git: string; ref: string } {
  if (input.sourceKind === 'git' && input.gitUrl?.trim()) {
    return { git: input.gitUrl.trim(), ref: input.gitRef?.trim() || 'main' }
  }
  return { files: {} }
}

// Server action: submit a run to the control plane with the authenticated user token (authZ is enforced by the control plane — may 403).
// caseId is auto-generated, with default graders. The repo seed is an empty working tree or a (private) git repo.
export async function submitRunAction(input: SubmitRunInput): Promise<SubmitRunResult> {
  const ctx = await authContext()
  const body = {
    harness: { id: input.harnessId, version: input.version || 'latest' },
    case: {
      id: `web-${Date.now().toString(36)}`,
      env: { kind: 'repo', source: repoSource(input) },
      task: input.task,
      graders: [{ id: 'steps' }, { id: 'cost' }, { id: 'latency' }],
      // Only send a timeout when the user set one; otherwise the EvalCase default (1800s) applies instead of the old hardcoded 300s cap.
      ...(input.timeoutSec ? { timeoutSec: input.timeoutSec } : {}),
      tags: ['web'],
    },
    // When runtime is selected the control plane injects it as case.placement.target (same as scorecard). Empty means the default backend.
    ...(input.runtime ? { runtime: input.runtime } : {}),
    trigger: 'web', // activity view source axis — submitted from web
  }
  try {
    const rec = await controlPlane.submitRun<{ id: string }>(ctx, body)
    revalidatePath('/[workspace]/runs')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
