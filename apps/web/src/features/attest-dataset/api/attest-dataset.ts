'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface AttestResult {
  ok: boolean
  error?: string
}

// Server action: approve a dataset version's `ground_truth` declarations. This is a CONSTITUTIONAL act —
// a metric declared ground truth outranks every judge, and rule `suite` says an authorization that leaves
// no artifact authorizes nothing. The control plane records the approval against the exact content; if the
// bytes move, the receipt no longer names them and a submit is refused.
export async function attestDatasetVersionAction(
  id: string,
  version: string,
  note: string
): Promise<AttestResult> {
  const ctx = await authContext()
  try {
    await controlPlane.attestDatasetVersion(ctx, id, version, { mode: 'approved', note })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
