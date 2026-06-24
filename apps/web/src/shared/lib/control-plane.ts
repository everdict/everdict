import 'server-only'

import { env } from '@/shared/config/env'

// 컨트롤플레인(@assay/api) HTTP 클라이언트 — 서버에서만 호출.
// 인증 컨텍스트: 로그인 사용자는 Keycloak 액세스 토큰을 Authorization: Bearer 로 그대로 전달하고
// (인증/인가 판단은 컨트롤플레인이 한다), Keycloak 미설정(dev)에선 x-assay-tenant 로 폴백한다.
// workspace 가 있으면(=사이드바에서 전환한 활성 워크스페이스 쿠키) x-assay-workspace 로 전달해 그 워크스페이스로 스코프한다.
export type AuthContext = ({ bearer: string } | { devTenant: string }) & { workspace?: string }

function authHeaders(auth: AuthContext): Record<string, string> {
  const headers: Record<string, string> =
    'bearer' in auth
      ? { authorization: `Bearer ${auth.bearer}` }
      : { 'x-assay-tenant': auth.devTenant }
  if (auth.workspace) headers['x-assay-workspace'] = auth.workspace
  return headers
}

// 컨트롤플레인 에러 응답 → 사람이 읽을 메시지. 플랫 envelope {code,message} 면 message 를 그대로 노출(예: HF 접속
// 불가 같은 친화 메시지가 화면에 "자연스럽게" 보이도록). envelope 가 아니면 경로/상태로 폴백(디버깅용).
function controlPlaneError(path: string, status: number, raw: string): Error {
  try {
    const j = JSON.parse(raw) as { message?: unknown }
    if (typeof j.message === 'string' && j.message.trim()) return new Error(j.message)
  } catch {
    // non-JSON 본문 — 아래 폴백
  }
  return new Error(`control-plane ${path} → ${status}: ${raw.slice(0, 300)}`)
}

async function call<T>(auth: AuthContext, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(auth), ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  if (!res.ok) throw controlPlaneError(path, res.status, await res.text())
  return res.json() as Promise<T>
}

// 204(No Content) 응답 전용 — 본문이 없어 res.json() 을 호출하면 안 되는 변경(예: 시크릿 set/delete).
async function callVoid(auth: AuthContext, path: string, init?: RequestInit): Promise<void> {
  const res = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(auth), ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  if (!res.ok) throw controlPlaneError(path, res.status, await res.text())
}

export const controlPlane = {
  me: <T>(auth: AuthContext) => call<T>(auth, '/me'),
  // 워크스페이스 멤버십(self-serve): 내 워크스페이스 목록 + 생성(생성자는 admin).
  listWorkspaces: <T>(auth: AuthContext) => call<T>(auth, '/workspaces'),
  createWorkspace: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspaces', { method: 'POST', body: JSON.stringify(body) }),
  // 활성 워크스페이스 레코드(이름/로고/소유자) 조회·수정·삭제. 단수 /workspace.
  getWorkspace: <T>(auth: AuthContext) => call<T>(auth, '/workspace'),
  updateWorkspace: <T>(auth: AuthContext, patch: unknown) =>
    call<T>(auth, '/workspace', { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteWorkspace: (auth: AuthContext) => callVoid(auth, '/workspace', { method: 'DELETE' }),
  listRuns: <T>(auth: AuthContext) => call<T>(auth, '/runs'),
  getRun: <T>(auth: AuthContext, id: string) => call<T>(auth, `/runs/${encodeURIComponent(id)}`),
  submitRun: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/runs', { method: 'POST', body: JSON.stringify(body) }),
  listHarnesses: <T>(auth: AuthContext) => call<T>(auth, '/harnesses'),
  // GET /harnesses/:id — 한 하니스의 인스턴스 버전 태그 목록.
  getHarness: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(id)}`),
  // GET /harnesses/:id/:version — resolved HarnessSpec(template + pins). 상세/도식화용.
  getHarnessSpec: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(id)}/${encodeURIComponent(version)}`),
  // 인스턴스(template + pins) 등록/검증 — /harnesses 가 인스턴스 표면.
  registerHarness: <T>(auth: AuthContext, instance: unknown) =>
    call<T>(auth, '/harnesses', { method: 'POST', body: JSON.stringify(instance) }),
  validateHarness: <T>(auth: AuthContext, instance: unknown) =>
    call<T>(auth, '/harnesses/validate', { method: 'POST', body: JSON.stringify(instance) }),
  // 템플릿(대분류: 구조/슬롯) 목록/조회/등록/검증 — /harness-templates.
  listHarnessTemplates: <T>(auth: AuthContext) => call<T>(auth, '/harness-templates'),
  getHarnessTemplate: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/harness-templates/${encodeURIComponent(id)}`),
  registerHarnessTemplate: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/harness-templates', { method: 'POST', body: JSON.stringify(spec) }),
  validateHarnessTemplate: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/harness-templates/validate', { method: 'POST', body: JSON.stringify(spec) }),
  listDatasets: <T>(auth: AuthContext) => call<T>(auth, '/datasets'),
  getDataset: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/datasets/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  // 버전 간 diff — base↔candidate 의 케이스 추가/삭제/변경 + 메타 변경. version 은 "latest" 가능.
  diffDataset: <T>(auth: AuthContext, id: string, base: string, candidate: string) =>
    call<T>(
      auth,
      `/datasets/${encodeURIComponent(id)}/diff?base=${encodeURIComponent(base)}&candidate=${encodeURIComponent(candidate)}`
    ),
  createDataset: <T>(auth: AuthContext, dataset: unknown) =>
    call<T>(auth, '/datasets', { method: 'POST', body: JSON.stringify(dataset) }),
  validateDataset: <T>(auth: AuthContext, dataset: unknown) =>
    call<T>(auth, '/datasets/validate', { method: 'POST', body: JSON.stringify(dataset) }),
  listBenchmarks: <T>(auth: AuthContext) => call<T>(auth, '/benchmarks'),
  // HF Hub 데이터셋 검색 + config/split — 위저드가 raw id 직접 입력 대신 검색/선택.
  searchHfDatasets: <T>(auth: AuthContext, query: string, limit?: number) =>
    call<T>(
      auth,
      `/benchmarks/hf/datasets?q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ''}`
    ),
  hfDatasetSplits: <T>(auth: AuthContext, dataset: string) =>
    call<T>(auth, `/benchmarks/hf/splits?dataset=${encodeURIComponent(dataset)}`),
  // 소스 미리보기(매핑 전 원본 행 + 감지된 필드) — "벤치마크 추가" 위저드.
  previewBenchmarkSource: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/benchmarks/preview', { method: 'POST', body: JSON.stringify(body) }),
  importBenchmark: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/benchmarks/import', { method: 'POST', body: JSON.stringify(body) }),
  listBenchmarkRecipes: <T>(auth: AuthContext) => call<T>(auth, '/benchmark-recipes'),
  registerBenchmarkRecipe: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/benchmark-recipes', { method: 'POST', body: JSON.stringify(spec) }),
  validateBenchmarkRecipe: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/benchmark-recipes/validate', { method: 'POST', body: JSON.stringify(spec) }),
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
  // 기간 트렌드 / 회귀-오버-타임: 한 (dataset, metric) 의 스코어카드 시계열 + baseline 대비 회귀.
  trendScorecards: <T>(
    auth: AuthContext,
    params: { dataset: string; metric?: string; harness?: string; baseline?: string }
  ) => {
    const q = new URLSearchParams({ dataset: params.dataset })
    if (params.metric) q.set('metric', params.metric)
    if (params.harness) q.set('harness', params.harness)
    if (params.baseline) q.set('baseline', params.baseline)
    return call<T>(auth, `/scorecards/trend?${q.toString()}`)
  },
  listJudges: <T>(auth: AuthContext) => call<T>(auth, '/judges'),
  getJudge: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/judges/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  createJudge: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/judges', { method: 'POST', body: JSON.stringify(spec) }),
  validateJudge: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/judges/validate', { method: 'POST', body: JSON.stringify(spec) }),
  // models — 추론/판정 모델(provider + 하부 모델 + baseUrl). judge/harness 가 id 로 참조.
  listModels: <T>(auth: AuthContext) => call<T>(auth, '/models'),
  getModel: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/models/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  createModel: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/models', { method: 'POST', body: JSON.stringify(spec) }),
  validateModel: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/models/validate', { method: 'POST', body: JSON.stringify(spec) }),
  // metrics — 런타임 정의 합격규칙(threshold). 스코어카드 실행/인제스트 시 선택해 post-hoc 적용.
  listMetrics: <T>(auth: AuthContext) => call<T>(auth, '/metrics'),
  getMetric: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/metrics/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  createMetric: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/metrics', { method: 'POST', body: JSON.stringify(spec) }),
  validateMetric: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/metrics/validate', { method: 'POST', body: JSON.stringify(spec) }),
  listRuntimes: <T>(auth: AuthContext) => call<T>(auth, '/runtimes'),
  getRuntime: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/runtimes/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  createRuntime: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/runtimes', { method: 'POST', body: JSON.stringify(spec) }),
  validateRuntime: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/runtimes/validate', { method: 'POST', body: JSON.stringify(spec) }),
  // 연결 테스트(라이브) — 잡 없이 클러스터 도달성/인증만 확인. 자격증명은 컨트롤플레인이 시크릿에서 resolve.
  probeRuntime: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/runtimes/probe', { method: 'POST', body: JSON.stringify(spec) }),
  getWorkspaceSettings: <T>(auth: AuthContext) => call<T>(auth, '/workspace/settings'),
  setWorkspaceSettings: <T>(auth: AuthContext, patch: unknown) =>
    call<T>(auth, '/workspace/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  // 워크스페이스 시크릿(모델/프로바이더 키 + 클러스터 자격증명) — 값은 절대 반환되지 않음(목록=이름+updatedAt).
  // at-rest 암호화는 컨트롤플레인 SecretStore. set/delete 는 204(본문 없음) → callVoid.
  listSecrets: <T>(auth: AuthContext) => call<T>(auth, '/secrets'),
  setSecret: (auth: AuthContext, name: string, value: string) =>
    callVoid(auth, `/secrets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  deleteSecret: (auth: AuthContext, name: string) =>
    callVoid(auth, `/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  // 외부 계정 연결(Connected accounts, 아웃바운드 OAuth). 개인 소유 — 목록=내(subject) 연결 메타만(토큰 없음) + 연결 가능한 provider.
  // start 는 authorizeUrl 을 돌려주고(브라우저를 그 URL 로 보낸다), disconnect 는 204(callVoid).
  listConnections: <T>(auth: AuthContext) => call<T>(auth, '/connections'),
  // 워크스페이스 애플리케이션 로스터(읽기 전용) — 이 워크스페이스에서 만들어진 연결 메타만(members:read).
  listWorkspaceApplications: <T>(auth: AuthContext) => call<T>(auth, '/workspace/applications'),
  startConnection: <T>(auth: AuthContext, provider: string, body: unknown) =>
    call<T>(auth, `/connections/${encodeURIComponent(provider)}/start`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  disconnectConnection: (auth: AuthContext, id: string) =>
    callVoid(auth, `/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 셀프호스티드 러너(개인 소유 디바이스 페어링). 목록=내(subject) 러너 메타만(토큰 없음).
  // pair 는 평문 토큰(rnr_…)을 1회만 돌려주고(저장은 해시), revoke 는 204(callVoid).
  listRunners: <T>(auth: AuthContext) => call<T>(auth, '/runners'),
  pairRunner: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/runners', { method: 'POST', body: JSON.stringify(body) }),
  revokeRunner: (auth: AuthContext, id: string) =>
    callVoid(auth, `/runners/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // API 키(에이전트/MCP 용 ak_…). 발급 시 평문은 1회만 반환, 목록은 prefix 만(평문/해시 미반환), 취소(204).
  listKeys: <T>(auth: AuthContext) => call<T>(auth, '/keys'),
  createKey: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/keys', { method: 'POST', body: JSON.stringify(body) }),
  revokeKey: (auth: AuthContext, id: string) =>
    callVoid(auth, `/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 워크스페이스 멤버 관리(조회=viewer+, 역할변경/제거=admin) + 초대(발급/목록/취소=admin, 수락=인증만).
  listMembers: <T>(auth: AuthContext) => call<T>(auth, '/members'),
  setMemberRole: (auth: AuthContext, subject: string, role: string) =>
    callVoid(auth, `/members/${encodeURIComponent(subject)}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  removeMember: (auth: AuthContext, subject: string) =>
    callVoid(auth, `/members/${encodeURIComponent(subject)}`, { method: 'DELETE' }),
  listInvites: <T>(auth: AuthContext) => call<T>(auth, '/invites'),
  createInvite: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/invites', { method: 'POST', body: JSON.stringify(body) }),
  revokeInvite: (auth: AuthContext, id: string) =>
    callVoid(auth, `/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  acceptInvite: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/invites/accept', { method: 'POST', body: JSON.stringify(body) }),
  // 내 프로필(이름/유저네임/아바타) 수정 — email 은 SSO(읽기전용)라 안 받는다. PATCH /me/profile → 갱신된 프로필.
  updateProfile: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/me/profile', { method: 'PATCH', body: JSON.stringify(body) }),
  // 이 워크스페이스에서 나가기(self-serve). 마지막 admin 이면 409. 204(본문 없음) → callVoid.
  leaveWorkspace: (auth: AuthContext) => callVoid(auth, '/members/me', { method: 'DELETE' }),
}
