import 'server-only'

import { env } from '@/shared/config/env'

// 컨트롤플레인(@assay/api) HTTP 클라이언트 — 서버에서만 호출.
// 인증 컨텍스트: 로그인 사용자는 Keycloak 액세스 토큰을 Authorization: Bearer 로 그대로 전달하고
// (인증/인가 판단은 컨트롤플레인이 한다), Keycloak 미설정(dev)에선 x-assay-tenant 로 폴백한다.
export type AuthContext = { bearer: string } | { devTenant: string }

function authHeaders(auth: AuthContext): Record<string, string> {
  return 'bearer' in auth
    ? { authorization: `Bearer ${auth.bearer}` }
    : { 'x-assay-tenant': auth.devTenant }
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
  validateHarness: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/harnesses/validate', { method: 'POST', body: JSON.stringify(spec) }),
  listDatasets: <T>(auth: AuthContext) => call<T>(auth, '/datasets'),
  getDataset: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/datasets/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  createDataset: <T>(auth: AuthContext, dataset: unknown) =>
    call<T>(auth, '/datasets', { method: 'POST', body: JSON.stringify(dataset) }),
  validateDataset: <T>(auth: AuthContext, dataset: unknown) =>
    call<T>(auth, '/datasets/validate', { method: 'POST', body: JSON.stringify(dataset) }),
  listBenchmarks: <T>(auth: AuthContext) => call<T>(auth, '/benchmarks'),
  importBenchmark: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/benchmarks/import', { method: 'POST', body: JSON.stringify(body) }),
  listBenchmarkRecipes: <T>(auth: AuthContext) => call<T>(auth, '/benchmark-recipes'),
  registerBenchmarkRecipe: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/benchmark-recipes', { method: 'POST', body: JSON.stringify(spec) }),
  listScorecards: <T>(auth: AuthContext) => call<T>(auth, '/scorecards'),
  getScorecard: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/scorecards/${encodeURIComponent(id)}`),
  runScorecard: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/scorecards', { method: 'POST', body: JSON.stringify(body) }),
  ingestScorecard: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/scorecards/ingest', { method: 'POST', body: JSON.stringify(body) }),
  ingestScorecardPull: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/scorecards/ingest/pull', { method: 'POST', body: JSON.stringify(body) }),
  diffScorecards: <T>(auth: AuthContext, baseline: string, candidate: string) =>
    call<T>(
      auth,
      `/scorecards/diff?baseline=${encodeURIComponent(baseline)}&candidate=${encodeURIComponent(candidate)}`
    ),
  listJudges: <T>(auth: AuthContext) => call<T>(auth, '/judges'),
  getJudge: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/judges/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  createJudge: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/judges', { method: 'POST', body: JSON.stringify(spec) }),
  validateJudge: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/judges/validate', { method: 'POST', body: JSON.stringify(spec) }),
  listRuntimes: <T>(auth: AuthContext) => call<T>(auth, '/runtimes'),
  getRuntime: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/runtimes/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  createRuntime: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/runtimes', { method: 'POST', body: JSON.stringify(spec) }),
  validateRuntime: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/runtimes/validate', { method: 'POST', body: JSON.stringify(spec) }),
  getWorkspaceSettings: <T>(auth: AuthContext) => call<T>(auth, '/workspace/settings'),
  setWorkspaceSettings: <T>(auth: AuthContext, patch: unknown) =>
    call<T>(auth, '/workspace/settings', { method: 'PUT', body: JSON.stringify(patch) }),
}
