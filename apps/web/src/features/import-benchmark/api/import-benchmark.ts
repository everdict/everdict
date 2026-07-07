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

// Pull a catalog/recipe/inline spec and register it as a dataset in this workspace. AuthZ (member+), HF fetch, and immutability (409) are enforced by the control plane.
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

// Source preview — raw rows + detected fields, before mapping. Called by the wizard before it fills the field dropdowns and maps them.
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

// HF Hub search — find dataset candidates by query (avoids typing an exact id directly).
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

// config/split combinations for the selected HF dataset — for the dropdown.
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

// List of repo data files (csv/jsonl/json) — a direct file-fetch fallback for datasets not served by the viewer (datasets-server).
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
