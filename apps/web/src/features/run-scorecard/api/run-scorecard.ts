'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface RunScorecardInput {
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  concurrency?: number // 배치 내 동시 디스패치 케이스 수(병렬도). 미지정이면 컨트롤플레인 기본.
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
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
  }
  try {
    const rec = await controlPlane.runScorecard<{ id: string }>(ctx, body)
    revalidatePath('/[workspace]/scorecards')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
