'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SubmitRunInput {
  harnessId: string
  version: string
  task: string
  // 실행할 테넌트 Runtime id(placement.target). 빈 문자열이면 기본 백엔드. self:<id> = 내 로컬 러너.
  runtime?: string
  // repo 시드: 'files'(빈 작업트리, 기본) | 'git'(원격 repo). git 이면 gitUrl 필수. 비공개는 워크스페이스
  // GitHub App 이 그 repo 에 설치돼 있으면 컨트롤플레인이 자동 인증 clone(제출 시 연결 선택 없음).
  sourceKind?: 'files' | 'git'
  gitUrl?: string
  gitRef?: string
}
export interface SubmitRunResult {
  ok: boolean
  id?: string
  error?: string
}

// repo 시드 출처를 입력에서 구성. git 이면 비공개는 워크스페이스 GitHub App 이 dispatch 시각에 자동 인증(제출 입력 없음).
function repoSource(
  input: SubmitRunInput
): { files: Record<string, string> } | { git: string; ref: string } {
  if (input.sourceKind === 'git' && input.gitUrl?.trim()) {
    return { git: input.gitUrl.trim(), ref: input.gitRef?.trim() || 'main' }
  }
  return { files: {} }
}

// 서버 액션: 인증된 사용자 토큰으로 컨트롤플레인에 run 제출(authZ 는 컨트롤플레인이 강제 — 403 가능).
// caseId 는 자동 생성, 기본 그레이더. repo 시드는 빈 작업트리 또는 (비공개) git repo.
export async function submitRunAction(input: SubmitRunInput): Promise<SubmitRunResult> {
  const ctx = await authContext()
  const body = {
    harness: { id: input.harnessId, version: input.version || 'latest' },
    case: {
      id: `web-${Date.now().toString(36)}`,
      env: { kind: 'repo', source: repoSource(input) },
      task: input.task,
      graders: [{ id: 'steps' }, { id: 'cost' }, { id: 'latency' }],
      timeoutSec: 300,
      tags: ['web'],
    },
    // runtime 선택 시 컨트롤플레인이 case.placement.target 으로 주입(scorecard 와 동일). 빈 값이면 기본 백엔드.
    ...(input.runtime ? { runtime: input.runtime } : {}),
    trigger: 'web', // 활동 뷰 source 축 — 웹에서 제출
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
