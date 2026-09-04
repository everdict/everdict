// ⚠️ NOT a `'use server'` module. A server-action file may export ONLY async functions, and this holds the
// schemas and the metric vocabulary the panel needs on the client — putting them beside the actions made
// the whole page fail to build ("A \"use server\" file can only export async functions, found object"), and
// it failed at BUILD rather than at type-check, which is why the split is worth a comment.
import { z } from 'zod'


// ── PERCEPTION AND ADMISSION, THE TWO THINGS EVERY TRAJECTORY IS MEASURED AGAINST ───────────────────
//
// A threshold crossing lands `trace.threshold_crossed` on the log at seal time; the ingestion admission is
// the OTLP door's events/hour ceiling. Both applied to every trajectory and neither could be read from the
// web, so a workspace could be silently dropping events past a quota nobody could see. Census slice 5.
// docs/architecture/web-runtime-gap-census-spec.md
export const TRACE_THRESHOLD_METRICS = [
  'usd',
  'total_tokens',
  'llm_calls',
  'tool_calls',
  'tool_failures',
  'events',
  'latency_ms_max',
] as const

export const traceThresholdSchema = z.object({
  name: z.string().min(1).max(120),
  metric: z.enum(TRACE_THRESHOLD_METRICS),
  value: z.number().nonnegative(),
})
export type TraceThreshold = z.infer<typeof traceThresholdSchema>

export const traceThresholdsSchema = z.object({ thresholds: z.array(traceThresholdSchema).default([]) })
// `null` is "no ceiling", which is a DIFFERENT setting from a very large number — the wire says null rather
// than a sentinel, and this keeps that distinction instead of collapsing it into a number.
export const traceIngestionSchema = z.object({
  maxEventsPerHour: z.number().int().nullable().optional(),
  usedThisHour: z.number().int().optional(),
})
export type TraceIngestion = z.infer<typeof traceIngestionSchema>

