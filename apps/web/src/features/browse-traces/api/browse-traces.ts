'use server'

import {
  harnessSpanMappingResponseSchema,
  traceInspectResultSchema,
  tracesListResponseSchema,
  type SpanAttrMapping,
  type TraceInspectResult,
  type TraceSummary,
} from '@/entities/trace'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export type ListTracesResult = { ok: true; traces: TraceSummary[] } | { ok: false; error: string }

// Enumerate a registered source's recent traces (the settings observability view + the judge-wizard sample picker).
// authZ (harnesses:read) is enforced by the control plane.
export async function listTracesAction(
  sourceName: string,
  query: { scope?: string; limit?: number } = {}
): Promise<ListTracesResult> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.listTraceSourceTraces(ctx, sourceName, query)
    return { ok: true, traces: tracesListResponseSchema.parse(raw).traces }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type InspectTraceResult =
  | { ok: true; result: TraceInspectResult }
  | { ok: false; error: string }

// Inspect one trace by id — raw span attributes (span-based kinds) + events normalized with the supplied mapping.
// The wizard re-calls this on each mapping edit to re-normalize live. Nothing is persisted.
export async function inspectTraceAction(
  sourceName: string,
  traceId: string,
  mapping?: SpanAttrMapping
): Promise<InspectTraceResult> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.inspectTrace(
      ctx,
      sourceName,
      traceId,
      mapping ? { mapping } : {}
    )
    return { ok: true, result: traceInspectResultSchema.parse(raw) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type MappingMutationResult = { ok: true } | { ok: false; error: string }

// Store (or clear, with mapping=null) a harness's span-attribute mapping overlay — the conversion layer authored in the
// judge wizard against a real trace. authZ (harnesses:register) is enforced by the control plane.
export async function saveHarnessSpanMappingAction(
  harnessId: string,
  mapping: SpanAttrMapping | null
): Promise<MappingMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.setHarnessSpanMapping(ctx, harnessId, { mapping })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Read a harness's stored overlay (to prefill the wizard editor when re-authoring). null = no overlay set.
export async function getHarnessSpanMappingAction(
  harnessId: string
): Promise<{ ok: true; mapping: SpanAttrMapping | null } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    const raw = harnessSpanMappingResponseSchema.parse(
      await controlPlane.getHarnessSpanMapping(ctx, harnessId)
    )
    return { ok: true, mapping: raw.mapping }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
