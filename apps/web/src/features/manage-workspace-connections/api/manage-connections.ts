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

// self-hosted(GHE/Mattermost) 연결 시 폼 입력. github.com 은 생략(원클릭).
export interface SelfHostedConnectInput {
  host: string
  clientId: string
  clientSecretName: string // client_secret 이 저장된 SecretStore 키 이름(값 아님)
}

// OAuth 시작 — 컨트롤플레인이 authorizeUrl 을 만들어 돌려준다. 클라이언트가 그 URL 로 브라우저를 보낸다.
// authZ(admin=connections:write)는 컨트롤플레인이 강제. self-hosted 면 host+clientId+clientSecretName 전달.
export async function startConnectionAction(
  provider: string,
  selfHosted?: SelfHostedConnectInput
): Promise<StartConnectionResult> {
  const ctx = await authContext()
  try {
    const res = connectionStartSchema.parse(
      await controlPlane.startConnection(ctx, provider, selfHosted ?? {})
    )
    return { ok: true, authorizeUrl: res.authorizeUrl }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 연결 해제(삭제). authZ(admin=connections:write)는 컨트롤플레인이 강제.
export async function disconnectConnectionAction(id: string): Promise<ConnectionMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.disconnectConnection(ctx, id)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
