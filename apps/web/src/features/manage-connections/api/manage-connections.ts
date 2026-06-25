'use server'

import { revalidatePath } from 'next/cache'

import { connectionStartSchema } from '@/entities/connection'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ConnectionMutationResult {
  ok: boolean
  error?: string
}
export interface StartConnectionResult {
  ok: boolean
  authorizeUrl?: string
  error?: string
}

// OAuth 시작 — 컨트롤플레인이 authorizeUrl 을 만들어 돌려준다. 클라이언트가 그 URL 로 브라우저를 보낸다.
// 연결은 개인 소유(self-scoped by subject) — 역할 게이트 없음. 멤버는 자격증명 입력 없이 원클릭: github.com 은 env 기본,
// self-hosted(GHE/Mattermost)는 관리자가 등록한 워크스페이스 통합에서 컨트롤플레인이 자격증명을 resolve.
export async function startConnectionAction(provider: string): Promise<StartConnectionResult> {
  const ctx = await authContext()
  try {
    const res = connectionStartSchema.parse(await controlPlane.startConnection(ctx, provider))
    return { ok: true, authorizeUrl: res.authorizeUrl }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 연결 해제(삭제). 연결은 개인 소유 — 본인 연결만 해제(컨트롤플레인이 subject 로 스코프).
export async function disconnectConnectionAction(id: string): Promise<ConnectionMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.disconnectConnection(ctx, id)
    revalidatePath('/[workspace]/account')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
