'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface TraceSourceMutationResult {
  ok: boolean
  error?: string
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

// Per-harness source selection (member, harnesses:register). source=null clears the selection (no pull).
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
