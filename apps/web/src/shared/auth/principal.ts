import 'server-only'

import { keycloakConfigured } from '@/shared/config/env'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

import { getAccessToken } from './access-token'
import { getActiveWorkspace } from './active-workspace'

// 내가 속한 워크스페이스(=GET /me 의 workspaces, 사이드바 스위처용).
export interface WebWorkspace {
  id: string
  name: string
  role: string
}

// 컨트롤플레인이 돌려주는 Principal (= GET /me). 웹은 이 값을 해석하지 않고 그대로 신뢰한다.
export interface WebPrincipal {
  subject: string
  workspace: string // 현재 활성 워크스페이스 id
  roles: string[]
  via: 'oidc' | 'api-key'
  workspaces?: WebWorkspace[] // 내가 속한 워크스페이스 목록(멤버십 스토어 있을 때)
}

// 현재 요청의 컨트롤플레인 인증 컨텍스트. 로그인 사용자 → Keycloak Bearer, dev(미설정) → x-assay-tenant=default.
// 활성 워크스페이스 쿠키가 있으면 동봉해(x-assay-workspace) 그 워크스페이스로 스코프한다(없거나 비멤버면 컨트롤플레인이 기본으로 폴백).
export async function authContext(): Promise<AuthContext> {
  const workspace = await getActiveWorkspace()
  const ws = workspace ? { workspace } : {}
  if (!keycloakConfigured) return { devTenant: 'default', ...ws }
  const token = await getAccessToken() // 서버 전용 — 클라이언트 세션에 토큰을 노출하지 않는다(BFF)
  return token ? { bearer: token, ...ws } : { devTenant: 'default', ...ws }
}

// 현재 Principal + 인증 컨텍스트. 워크스페이스/역할의 권위는 컨트롤플레인 GET /me (웹이 토큰을 해석하지 않음).
// 컨트롤플레인 미가동 등으로 실패하면 principal=null (호출부가 graceful 처리).
export async function currentPrincipal(): Promise<{
  principal: WebPrincipal | null
  ctx: AuthContext
}> {
  const ctx = await authContext()
  try {
    return { principal: await controlPlane.me<WebPrincipal>(ctx), ctx }
  } catch {
    return { principal: null, ctx }
  }
}
