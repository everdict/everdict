'use server'

import {
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
