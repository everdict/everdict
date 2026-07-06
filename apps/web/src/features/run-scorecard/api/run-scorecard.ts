'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface RunScorecardInput {
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  // 실행할 테넌트 Runtime id(placement.target) 또는 self 러너 타깃(self / self:<id> / self:ws).
  // 컨트롤플레인은 미지정 배치를 400(requireRuntime — 호스트 폴백 금지).
  runtime?: string
  concurrency?: number // 배치 내 동시 디스패치 케이스 수(병렬도). 미지정이면 컨트롤플레인 기본.
  cases?: { limit?: number; tags?: string[] } // 부분 실행 — 전체 데이터셋의 subset 만(미지정=전체)
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
    // runtime 선택 시 컨트롤플레인이 각 케이스 placement.target 으로 주입 → RuntimeDispatcher 라우팅.
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    ...(input.cases ? { cases: input.cases } : {}),
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
