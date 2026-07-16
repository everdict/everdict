'use server'

import { revalidatePath } from 'next/cache'

import { traceProbeResultSchema, type TraceProbeResult } from '@/entities/trace-probe'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface TraceSourceMutationResult {
  ok: boolean
  error?: string
}

// Connection test + scope discovery (before registering) — the web form gates Save on a reachable result and
// populates the scope picker from result.scopes. authZ (settings:write) is enforced by the control plane.
export async function probeTraceSourceAction(input: {
  kind: 'otel' | 'mlflow' | 'langfuse' | 'langsmith' | 'phoenix'
  endpoint: string
  authSecretName?: string
}): Promise<{ ok: true; result: TraceProbeResult } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.probeTraceSource(ctx, input)
    return { ok: true, result: traceProbeResultSchema.parse(raw) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Register/update a trace source (admin, upsert keyed by name). Put the auth token (value) into a workspace secret first and specify only its name.
// authZ (admin = settings:write) is enforced by the control plane.
export async function upsertTraceSourceAction(input: {
  name: string
  kind: 'otel' | 'mlflow' | 'langfuse' | 'langsmith' | 'phoenix'
  endpoint: string
  authSecretName?: string
  correlate?: 'id' | 'tag'
  service?: string
  project?: string
  webUrl?: string
}): Promise<TraceSourceMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.upsertTraceSource(ctx, input)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Delete a trace source (admin). Harnesses that had selected that source fall back to their inline spec.traceSource (or no pull) afterward.
export async function removeTraceSourceAction(name: string): Promise<TraceSourceMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeTraceSource(ctx, name)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Per-harness PULL selection (member, harnesses:register). source=null clears the selection (no pull).
export async function assignHarnessTraceSourceAction(
  harnessId: string,
  source: string | null
): Promise<TraceSourceMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.assignHarnessTraceSource(ctx, harnessId, { source })
    revalidatePath('/[workspace]/settings')
    revalidatePath('/[workspace]/harnesses/[id]', 'page')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Per-harness EXPORT selection (member, harnesses:register) — which registered source to export judged results to
// (a sink-capable source; otel is rejected server-side). source=null clears it (no export). Same pool as the pull selection.
export async function assignHarnessTraceSinkAction(
  harnessId: string,
  source: string | null
): Promise<TraceSourceMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.assignHarnessTraceSink(ctx, harnessId, { source })
    revalidatePath('/[workspace]/settings')
    revalidatePath('/[workspace]/harnesses/[id]', 'page')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
