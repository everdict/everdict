'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface RunScorecardInput {
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  // Tenant Runtime id to run on (placement.target) or a self runner target (self / self:<id> / self:ws).
  // The control plane 400s an unspecified placement (requireRuntime — no host fallback).
  runtime?: string
  concurrency?: number // Number of cases dispatched concurrently within the batch (parallelism). Unset uses the control plane default.
  cases?: { limit?: number; tags?: string[] } // Partial run — only a subset of the full dataset (unset = all)
}

export interface RunScorecardResult {
  ok: boolean
  id?: string
  error?: string
}

// Server action: submit a batch evaluation to the control plane with the authenticated user token (authZ is enforced by the control plane — may 403).
// A missing version becomes latest (the service resolves it to a concrete version). If the dataset is absent the control plane 404s.
export async function runScorecardAction(input: RunScorecardInput): Promise<RunScorecardResult> {
  const ctx = await authContext()
  const body = {
    dataset: { id: input.datasetId, version: input.datasetVersion || 'latest' },
    harness: { id: input.harnessId, version: input.harnessVersion || 'latest' },
    // When runtime is selected the control plane injects it as each case's placement.target → RuntimeDispatcher routing.
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    ...(input.cases ? { cases: input.cases } : {}),
  }
  try {
    const rec = await controlPlane.runScorecard<{ id: string }>(ctx, body)
    revalidatePath('/[workspace]/scorecards')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
