'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface GateResult {
  ok: boolean
  // FOUR outcomes, and only the first is a green light. `not_comparable` means the comparison does not
  // hold; `blocked_missing` means it held but not over enough. Collapsing either into "block" would tell a
  // reader the candidate regressed when nobody could tell.
  outcome?: 'pass' | 'block' | 'blocked_missing' | 'not_comparable'
  reason?: string
  error?: string
}

// Server action: rehearse the release gate over a baseline↔candidate pair. The route is the CI's door and
// has never been a person's, so the decision a release rests on could not be seen until a pipeline made it.
export async function gateScorecardsAction(baseline: string, candidate: string): Promise<GateResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.gateScorecards<{ outcome?: string; reason?: string }>(ctx, {
      baseline,
      candidate,
    })
    const outcome =
      out.outcome === 'pass' ||
      out.outcome === 'block' ||
      out.outcome === 'blocked_missing' ||
      out.outcome === 'not_comparable'
        ? out.outcome
        : undefined
    return { ok: true, ...(outcome ? { outcome } : {}), ...(out.reason ? { reason: out.reason } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
