'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — revalidatePath 금지 (docs/web.md §"A mutation refreshes").
export interface RescoreScorecardResult {
  ok: boolean
  rescoredJudges?: string[]
  skipped?: number
  error?: string
}

// Server action: re-score ONLY the batch's retryable-unmeasured judge scores in place (transient judge
// LLM/transport blips) — no case is re-executed, judge versions come from the batch's own pins. AuthZ is the
// control plane's (scorecards:run — may 403; no per-case results yet → 400).
export async function rescoreScorecardAction(id: string): Promise<RescoreScorecardResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.rescoreScorecardUnmeasured<{
      rescoredJudges: string[]
      skipped: unknown[]
    }>(ctx, id)
    return { ok: true, rescoredJudges: out.rescoredJudges, skipped: out.skipped.length }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
