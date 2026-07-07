'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface TraceSinkMutationResult {
  ok: boolean
  error?: string
}

// Register/update a trace sink (admin, upsert keyed by name). Put the auth token (value) into a workspace secret first and specify only its name.
// authZ (admin = settings:write) is enforced by the control plane.
export async function upsertTraceSinkAction(input: {
  name: string
  kind: 'mlflow' | 'langfuse' | 'langsmith' | 'phoenix'
  endpoint: string
  authSecretName?: string
  project?: string
  webUrl?: string
}): Promise<TraceSinkMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.upsertTraceSink(ctx, input)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Delete a trace sink (admin). Detail results of harnesses that had selected that sink stay only in Everdict afterward, with no external export.
export async function removeTraceSinkAction(name: string): Promise<TraceSinkMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.removeTraceSink(ctx, name)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Per-harness sink selection (member, harnesses:register). sink=null clears the selection (no export).
export async function assignHarnessTraceSinkAction(
  harnessId: string,
  sink: string | null
): Promise<TraceSinkMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.assignHarnessTraceSink(ctx, harnessId, { sink })
    revalidatePath('/[workspace]/settings')
    revalidatePath('/[workspace]/harnesses/[id]', 'page')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
