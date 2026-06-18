import 'server-only'

import { env } from '@/shared/config/env'

// 컨트롤플레인(@assay/api) HTTP 클라이언트 — 서버에서만 호출.
// 인증 컨텍스트: 로그인 사용자는 Keycloak 액세스 토큰을 Authorization: Bearer 로 그대로 전달하고
// (인증/인가 판단은 컨트롤플레인이 한다), Keycloak 미설정(dev)에선 x-assay-tenant 로 폴백한다.
export type AuthContext = { bearer: string } | { devTenant: string }

function authHeaders(auth: AuthContext): Record<string, string> {
  return 'bearer' in auth ? { authorization: `Bearer ${auth.bearer}` } : { 'x-assay-tenant': auth.devTenant }
}

async function call<T>(auth: AuthContext, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(auth), ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`control-plane ${path} → ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

export const controlPlane = {
  me: <T>(auth: AuthContext) => call<T>(auth, '/me'),
  listRuns: <T>(auth: AuthContext) => call<T>(auth, '/runs'),
  getRun: <T>(auth: AuthContext, id: string) => call<T>(auth, `/runs/${encodeURIComponent(id)}`),
  submitRun: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/runs', { method: 'POST', body: JSON.stringify(body) }),
  listHarnesses: <T>(auth: AuthContext) => call<T>(auth, '/harnesses'),
  registerHarness: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/harnesses', { method: 'POST', body: JSON.stringify(spec) }),
}
