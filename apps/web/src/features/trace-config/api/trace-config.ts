'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import {
  traceIngestionSchema,
  traceThresholdsSchema,
  type TraceIngestion,
  type TraceThreshold,
} from './trace-config-shapes'

export async function loadTraceConfig(): Promise<{
  thresholds?: TraceThreshold[]
  ingestion?: TraceIngestion
  error?: string
}> {
  const ctx = await authContext()
  try {
    const [t, i] = await Promise.all([
      controlPlane.traceThresholds<unknown>(ctx),
      controlPlane.traceIngestion<unknown>(ctx),
    ])
    return {
      thresholds: traceThresholdsSchema.parse(t).thresholds,
      ingestion: traceIngestionSchema.parse(i),
    }
  } catch (e) {
    // A read that failed is not "no thresholds" — an empty list would tell a member nothing is being
    // watched, which is the one wrong answer this settings page can give.
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function setTraceThresholdsAction(
  thresholds: TraceThreshold[]
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.setTraceThresholds(ctx, thresholds)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function setTraceIngestionAction(
  maxEventsPerHour: number | null
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.setTraceIngestion(ctx, maxEventsPerHour)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
