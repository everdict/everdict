import 'server-only'

import { env } from '@/shared/config/env'

// 컨트롤플레인(@assay/api) HTTP 클라이언트 — 서버에서만 호출.
// 웹은 Keycloak 으로 사람을 인증하는 신뢰 게이트웨이이므로, 내부망의 컨트롤플레인에는
// 인증된 tenant 를 x-assay-tenant 로 전달한다(운영에선 서비스 토큰 + 서명된 acts-as 로 강화).
async function call<T>(tenant: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-assay-tenant': tenant, ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`control-plane ${path} → ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

export const controlPlane = {
  listRuns: <T>(tenant: string) => call<T>(tenant, '/runs'),
  getRun: <T>(tenant: string, id: string) => call<T>(tenant, `/runs/${encodeURIComponent(id)}`),
  submitRun: <T>(tenant: string, body: unknown) =>
    call<T>(tenant, '/runs', { method: 'POST', body: JSON.stringify(body) }),
  listHarnesses: <T>(tenant: string) => call<T>(tenant, '/harnesses'),
  registerHarness: <T>(tenant: string, spec: unknown) =>
    call<T>(tenant, '/harnesses', { method: 'POST', body: JSON.stringify(spec) }),
}
