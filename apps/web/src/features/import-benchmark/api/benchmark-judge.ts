'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface BenchmarkJudgeResult {
  ok: boolean
  // The benchmark's OWN evaluator, shaped as a registerable code judge. Its presence is the point: cases
  // from the import, criterion from here, so "we ran benchmark X" means the same thing in two workspaces.
  judgeId?: string
  language?: string
  error?: string
}

// Server action: fetch a benchmark's official scorer. Read-only — it does not register anything, because
// adopting somebody else's criterion is a decision a person makes with the spec in front of them.
export async function benchmarkJudgeAction(id: string): Promise<BenchmarkJudgeResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.benchmarkJudge<{ id?: string; spec?: { language?: string } }>(ctx, id)
    return {
      ok: true,
      ...(out.id ? { judgeId: out.id } : {}),
      ...(out.spec?.language ? { language: out.spec.language } : {}),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
