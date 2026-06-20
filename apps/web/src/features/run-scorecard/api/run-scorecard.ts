'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface RunScorecardInput {
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  judgeIds: string[]
  runtime: string
  judgeModel?: string // inline judge grader 채점 모델(예: gpt-5.4-mini) — os-use 스크린샷 judge 등. 미지정이면 워크스페이스 기본.
}

export interface RunScorecardResult {
  ok: boolean
  id?: string
  error?: string
}

// 서버 액션: 인증된 사용자 토큰으로 컨트롤플레인에 배치 평가 제출(authZ 는 컨트롤플레인이 강제 — 403 가능).
// 버전 미입력은 latest 로(서비스가 구체 버전으로 해석). 데이터셋 없으면 컨트롤플레인이 404.
export async function runScorecardAction(input: RunScorecardInput): Promise<RunScorecardResult> {
  const ctx = await authContext()
  const body = {
    dataset: { id: input.datasetId, version: input.datasetVersion || 'latest' },
    harness: { id: input.harnessId, version: input.harnessVersion || 'latest' },
    judges: input.judgeIds.map((id) => ({ id, version: 'latest' })),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.judgeModel ? { judge: { provider: 'openai', model: input.judgeModel } } : {}),
  }
  try {
    const rec = await controlPlane.runScorecard<{ id: string }>(ctx, body)
    revalidatePath('/dashboard/scorecards')
    revalidatePath('/dashboard')
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
