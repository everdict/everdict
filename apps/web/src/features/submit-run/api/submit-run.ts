'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SubmitRunInput {
  harnessId: string
  version: string
  task: string
}
export interface SubmitRunResult {
  ok: boolean
  id?: string
  error?: string
}

// 서버 액션: 인증된 사용자 토큰으로 컨트롤플레인에 run 제출(authZ 는 컨트롤플레인이 강제 — 403 가능).
// caseId 는 자동 생성, repo 빈 시드 + 기본 그레이더.
export async function submitRunAction(input: SubmitRunInput): Promise<SubmitRunResult> {
  const ctx = await authContext()
  const body = {
    harness: { id: input.harnessId, version: input.version || 'latest' },
    case: {
      id: `web-${Date.now().toString(36)}`,
      env: { kind: 'repo', source: { files: {} } },
      task: input.task,
      graders: [{ id: 'steps' }, { id: 'cost' }, { id: 'latency' }],
      timeoutSec: 300,
      tags: ['web'],
    },
  }
  try {
    const rec = await controlPlane.submitRun<{ id: string }>(ctx, body)
    revalidatePath('/[workspace]/runs')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
