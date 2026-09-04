'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface EstimateResult {
  ok: boolean
  usd?: number
  seconds?: number
  // How many past batches the medians came from. ZERO is the honest answer when this pair has no history,
  // and it is NOT the same as "cheap" — a form that printed $0 there would be inventing a number.
  samples?: number
  error?: string
}

// Server action: a history-based preflight for a dataset×harness pair — per-case medians from the last few
// succeeded batches of the SAME pair. The route is honest when there is no history (samples: 0, no estimate
// block) and this action forwards that honesty rather than defaulting to zero.
export async function estimateScorecardAction(input: {
  dataset: string
  harness: string
  cases?: number
  concurrency?: number
}): Promise<EstimateResult> {
  const ctx = await authContext()
  const qs = new URLSearchParams({ dataset: input.dataset, harness: input.harness })
  if (input.cases !== undefined) qs.set('cases', String(input.cases))
  if (input.concurrency !== undefined) qs.set('concurrency', String(input.concurrency))
  try {
    const out = await controlPlane.estimateScorecard<{
      estimate?: { usd?: number; seconds?: number }
      basis?: { samples?: number }
    }>(ctx, `?${qs.toString()}`)
    return {
      ok: true,
      ...(out.estimate?.usd !== undefined ? { usd: out.estimate.usd } : {}),
      ...(out.estimate?.seconds !== undefined ? { seconds: out.estimate.seconds } : {}),
      samples: out.basis?.samples ?? 0,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
