import 'server-only'

import { keycloakConfigured } from '@/shared/config/env'
import { type AuthContext, controlPlane } from '@/shared/lib/control-plane'
import { getAccessToken } from './access-token'

// 컨트롤플레인이 돌려주는 Principal (= GET /me). 웹은 이 값을 해석하지 않고 그대로 신뢰한다.
export interface WebPrincipal {
  subject: string
  workspace: string
  roles: string[]
  via: 'oidc' | 'api-key'
}

// 현재 요청의 컨트롤플레인 인증 컨텍스트. 로그인 사용자 → Keycloak Bearer, dev(미설정) → x-assay-tenant=default.
export async function authContext(): Promise<AuthContext> {
  if (!keycloakConfigured) return { devTenant: 'default' }
  const token = await getAccessToken() // 서버 전용 — 클라이언트 세션에 토큰을 노출하지 않는다(BFF)
  return token ? { bearer: token } : { devTenant: 'default' }
}

// 현재 Principal + 인증 컨텍스트. 워크스페이스/역할의 권위는 컨트롤플레인 GET /me (웹이 토큰을 해석하지 않음).
// 컨트롤플레인 미가동 등으로 실패하면 principal=null (호출부가 graceful 처리).
export async function currentPrincipal(): Promise<{ principal: WebPrincipal | null; ctx: AuthContext }> {
  const ctx = await authContext()
  try {
    return { principal: await controlPlane.me<WebPrincipal>(ctx), ctx }
  } catch {
    return { principal: null, ctx }
  }
}
