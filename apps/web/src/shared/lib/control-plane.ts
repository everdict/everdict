import 'server-only'

import { env } from '@/shared/config/env'

// 컨트롤플레인(@everdict/api) HTTP 클라이언트 — 서버에서만 호출.
// 인증 컨텍스트: 로그인 사용자는 Keycloak 액세스 토큰을 Authorization: Bearer 로 그대로 전달하고
// (인증/인가 판단은 컨트롤플레인이 한다), Keycloak 미설정(dev)에선 x-everdict-tenant 로 폴백한다.
// workspace 가 있으면(=사이드바에서 전환한 활성 워크스페이스 쿠키) x-everdict-workspace 로 전달해 그 워크스페이스로 스코프한다.
export type AuthContext = ({ bearer: string } | { devTenant: string }) & { workspace?: string }

function authHeaders(auth: AuthContext): Record<string, string> {
  const headers: Record<string, string> =
    'bearer' in auth
      ? { authorization: `Bearer ${auth.bearer}` }
      : { 'x-everdict-tenant': auth.devTenant }
  if (auth.workspace) headers['x-everdict-workspace'] = auth.workspace
  return headers
}

// content-type: application/json 은 본문이 있을 때만 붙인다. 본문 없는 DELETE 에 이 헤더를 붙이면
// Fastify 가 빈 JSON 본문으로 보고 FST_ERR_CTP_EMPTY_JSON_BODY(400, "body cannot be empty…") 를 던진다.
function requestHeaders(auth: AuthContext, init?: RequestInit): Record<string, string> {
  const headers = authHeaders(auth)
  // 호출자 지정 헤더(HeadersInit)를 정규화해 합친다 — 호출자 값이 우선.
  if (init?.headers) for (const [k, v] of new Headers(init.headers)) headers[k] = v
  if (init?.body != null && headers['content-type'] === undefined)
    headers['content-type'] = 'application/json'
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
    headers: requestHeaders(auth, init),
    cache: 'no-store',
  })
  if (!res.ok) throw controlPlaneError(path, res.status, await res.text())
  return res.json() as Promise<T>
}

// 204(No Content) 응답 전용 — 본문이 없어 res.json() 을 호출하면 안 되는 변경(예: 시크릿 set/delete).
async function callVoid(auth: AuthContext, path: string, init?: RequestInit): Promise<void> {
  const res = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: requestHeaders(auth, init),
    cache: 'no-store',
  })
  if (!res.ok) throw controlPlaneError(path, res.status, await res.text())
}

export const controlPlane = {
  me: <T>(auth: AuthContext) => call<T>(auth, '/me'),
  // 알림 피드(개인 소유; 벨 인박스) — qs 는 '?unread=1&limit=30' 같은 원문 쿼리스트링.
  listNotifications: <T>(auth: AuthContext, qs: string) => call<T>(auth, `/notifications${qs}`),
  readNotifications: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/notifications/read', { method: 'POST', body: JSON.stringify(body) }),
  // 리소스 댓글(데이터셋 등) — 협업 논의. 조회=viewer+, 작성=member+, 삭제=작성자-or-admin(컨트롤플레인 강제).
  listComments: <T>(auth: AuthContext, resourceType: string, resourceId: string) =>
    call<T>(
      auth,
      `/comments?resourceType=${encodeURIComponent(resourceType)}&resourceId=${encodeURIComponent(resourceId)}`
    ),
  createComment: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/comments', { method: 'POST', body: JSON.stringify(body) }),
  deleteComment: (auth: AuthContext, id: string) =>
    callVoid(auth, `/comments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 워크스페이스 멤버십(self-serve): 내 워크스페이스 목록 + 생성(생성자는 admin).
  listWorkspaces: <T>(auth: AuthContext) => call<T>(auth, '/workspaces'),
  createWorkspace: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspaces', { method: 'POST', body: JSON.stringify(body) }),
  // 활성 워크스페이스 레코드(이름/로고/소유자) 조회·수정·삭제. 단수 /workspace.
  getWorkspace: <T>(auth: AuthContext) => call<T>(auth, '/workspace'),
  updateWorkspace: <T>(auth: AuthContext, patch: unknown) =>
    call<T>(auth, '/workspace', { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteWorkspace: (auth: AuthContext) => callVoid(auth, '/workspace', { method: 'DELETE' }),
  // scorecardId 지정 시 그 스코어카드의 케이스 자식 run(드릴다운); 아니면 standalone 활동 리스트(자식 숨김).
  listRuns: <T>(auth: AuthContext, opts?: { scorecardId?: string }) =>
    call<T>(
      auth,
      opts?.scorecardId ? `/runs?scorecardId=${encodeURIComponent(opts.scorecardId)}` : '/runs'
    ),
  getRun: <T>(auth: AuthContext, id: string) => call<T>(auth, `/runs/${encodeURIComponent(id)}`),
  // 작업 큐 스냅샷 — 런타임 레인별 실행 중/대기(FIFO)/다음 예약 발사.
  getQueue: <T>(auth: AuthContext) => call<T>(auth, '/queue'),
  submitRun: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/runs', { method: 'POST', body: JSON.stringify(body) }),
  listHarnesses: <T>(auth: AuthContext) => call<T>(auth, '/harnesses'),
  // GET /harnesses/:id — 한 하니스의 인스턴스 버전 태그 목록.
  getHarness: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(id)}`),
  // 버전 태그 교체(전체 배열 PUT; 빈 배열 = 제거) — 스펙 밖 자유 라벨(버전 분간용). 게이트는 각 엔티티의
  // 콘텐츠 mutation 액션(harnesses:register / datasets:write / runtimes:write) — 컨트롤플레인이 강제.
  setHarnessVersionTags: <T>(auth: AuthContext, id: string, version: string, tags: string[]) =>
    call<T>(
      auth,
      `/harnesses/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/tags`,
      { method: 'PUT', body: JSON.stringify({ tags }) }
    ),
  setDatasetVersionTags: <T>(auth: AuthContext, id: string, version: string, tags: string[]) =>
    call<T>(
      auth,
      `/datasets/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/tags`,
      {
        method: 'PUT',
        body: JSON.stringify({ tags }),
      }
    ),
  setRuntimeVersionTags: <T>(auth: AuthContext, id: string, version: string, tags: string[]) =>
    call<T>(
      auth,
      `/runtimes/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/tags`,
      {
        method: 'PUT',
        body: JSON.stringify({ tags }),
      }
    ),
  // GET /harnesses/:id/:version — resolved HarnessSpec(template + pins). 상세/도식화용.
  getHarnessSpec: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(id)}/${encodeURIComponent(version)}`),
  // GET /harnesses/:id/:version/instance — raw 인스턴스(template 참조 + pins). 구성 보기/새 버전 프리필용.
  getHarnessInstance: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(id)}/${encodeURIComponent(version)}/instance`),
  // GET /harness-templates/:id/:version — 템플릿(대분류) 구조 스펙 1건.
  getHarnessTemplateSpec: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/harness-templates/${encodeURIComponent(id)}/${encodeURIComponent(version)}`),
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
  // repo 데이터 파일 목록 — 뷰어 미서빙 데이터셋의 파일 직접 인출 폴백.
  hfDatasetFiles: <T>(auth: AuthContext, dataset: string) =>
    call<T>(auth, `/benchmarks/hf/files?dataset=${encodeURIComponent(dataset)}`),
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
  getBenchmarkRecipe: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(
      auth,
      `/benchmark-recipes/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`
    ),
  // 예약(cron) 스코어카드 — 저장된 RunScorecardInput + 크론식. 발사(Temporal)는 컨트롤플레인 slice 2.
  listSchedules: <T>(auth: AuthContext) => call<T>(auth, '/schedules'),
  getSchedule: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/schedules/${encodeURIComponent(id)}`),
  createSchedule: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/schedules', { method: 'POST', body: JSON.stringify(body) }),
  updateSchedule: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/schedules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteSchedule: (auth: AuthContext, id: string) =>
    callVoid(auth, `/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 저장된 스코어카드 분석 View — 이름 붙인 AnalysisConfig(불투명), 비공개|공유. 열 때 현재 데이터로 재실행(라이브).
  listViews: <T>(auth: AuthContext) => call<T>(auth, '/views'),
  getView: <T>(auth: AuthContext, id: string) => call<T>(auth, `/views/${encodeURIComponent(id)}`),
  createView: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/views', { method: 'POST', body: JSON.stringify(body) }),
  updateView: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/views/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteView: (auth: AuthContext, id: string) =>
    callVoid(auth, `/views/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
  // 벤치마크별 리더보드: 한 데이터셋의 (harness × model) 랭킹(metric 내림차순). window=latest(기본)|best.
  leaderboardScorecards: <T>(
    auth: AuthContext,
    params: {
      dataset: string
      metric?: string
      harness?: string
      model?: string
      judgeModel?: string
      window?: 'latest' | 'best'
    }
  ) => {
    const q = new URLSearchParams({ dataset: params.dataset })
    if (params.metric) q.set('metric', params.metric)
    if (params.harness) q.set('harness', params.harness)
    if (params.model) q.set('model', params.model)
    if (params.judgeModel) q.set('judgeModel', params.judgeModel)
    if (params.window) q.set('window', params.window)
    return call<T>(auth, `/scorecards/leaderboard?${q.toString()}`)
  },
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
  setSecret: (
    auth: AuthContext,
    name: string,
    value: string,
    scope: 'user' | 'workspace' = 'workspace'
  ) =>
    callVoid(auth, `/secrets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ value, scope }),
    }),
  deleteSecret: (auth: AuthContext, name: string, scope: 'user' | 'workspace' = 'workspace') =>
    callVoid(auth, `/secrets/${encodeURIComponent(name)}?scope=${scope}`, { method: 'DELETE' }),
  // 워크스페이스 소유 GitHub App 통합(조직 설치→선택 repo). 조회/설치시작/등록/해제 모두 settings:read|write(admin).
  // 개인키/토큰 값은 절대 안 내려옴 — installation 은 온디맨드 토큰 발급이라 비밀 없이 메타만.
  getGithubApp: <T>(auth: AuthContext) => call<T>(auth, '/workspace/github-app'),
  startGithubAppInstall: <T>(auth: AuthContext, body?: unknown) =>
    call<T>(auth, '/workspace/github-app/install/start', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),
  registerGithubApp: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/github-app/registrations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // host 는 URL(슬래시/콜론 포함)이라 경로 대신 쿼리로.
  removeGithubAppRegistration: <T>(auth: AuthContext, host: string) =>
    call<T>(auth, `/workspace/github-app/registrations?host=${encodeURIComponent(host)}`, {
      method: 'DELETE',
    }),
  unlinkGithubAppInstallation: <T>(auth: AuthContext, installationId: number) =>
    call<T>(auth, `/workspace/github-app/installations/${encodeURIComponent(installationId)}`, {
      method: 'DELETE',
    }),
  // 워크스페이스 App installation 이 접근 가능한 레포 목록(CI repo link picker). 설치 시 고른 것만. settings:read.
  getGithubAppRepos: <T>(auth: AuthContext) => call<T>(auth, '/workspace/github-app/repos'),
  // 워크스페이스 소유 Mattermost 통합(등록→bot 알림). 조회 settings:read / 등록·해제 settings:write. bot 토큰 값은 SecretStore 에만.
  getMattermost: <T>(auth: AuthContext) => call<T>(auth, '/workspace/mattermost'),
  setMattermost: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/mattermost', { method: 'PUT', body: JSON.stringify(body) }),
  removeMattermost: (auth: AuthContext) =>
    callVoid(auth, '/workspace/mattermost', { method: 'DELETE' }),
  // 워크스페이스 트레이스 싱크(복수) — judge 된 스코어카드 상세 결과를 팀 관측 플랫폼(MLflow 등)에 적재.
  // 조회 harnesses:read(viewer+ — 하니스별 선택 표시용) / 등록(name 기준 upsert)·삭제 settings:write.
  // 인증 값은 SecretStore 에만(이름 참조만 오간다).
  listTraceSinks: <T>(auth: AuthContext) => call<T>(auth, '/workspace/trace-sinks'),
  upsertTraceSink: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/trace-sinks', { method: 'PUT', body: JSON.stringify(body) }),
  removeTraceSink: (auth: AuthContext, name: string) =>
    callVoid(auth, `/workspace/trace-sinks/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  // 하니스별 싱크 선택(assignment) — body { sink: name | null }, null 이면 선택 해제(적재 안 함).
  // harnesses:register(member+) — 싱크 자체(등록/삭제)는 admin, 어디에 적재할지는 하니스 소유자 몫.
  assignHarnessTraceSink: <T>(auth: AuthContext, harnessId: string, body: unknown) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(harnessId)}/trace-sink`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // 워크스페이스 이미지 레지스트리(BYO, 복수) — 하니스 이미지 분류 기준 + everdict image push 발행 대상.
  // 조회 harnesses:read(viewer+ — 분류 배지용) / 등록(name 기준 upsert)·삭제 settings:write. 시크릿은 이름 참조만 오간다.
  listImageRegistries: <T>(auth: AuthContext) => call<T>(auth, '/workspace/image-registries'),
  upsertImageRegistry: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/image-registries', { method: 'PUT', body: JSON.stringify(body) }),
  removeImageRegistry: (auth: AuthContext, name: string) =>
    callVoid(auth, `/workspace/image-registries/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  // CI repo link(레포↔하니스 슬롯 = GitHub Actions OIDC trust). 조회=harnesses:read(viewer+), 생성/삭제=settings:write(admin).
  // link 의 존재가 그 레포의 keyless CI 신뢰를 부여한다. 세 라우트 모두 현재 링크 전체({links})를 돌려준다(204 아님).
  listCiLinks: <T>(auth: AuthContext) => call<T>(auth, '/workspace/ci/links'),
  upsertCiLink: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/ci/links', { method: 'PUT', body: JSON.stringify(body) }),
  // repository("owner/name")는 슬래시를 포함해 경로 대신 쿼리로 받는다. host 미지정 = github.com link.
  deleteCiLink: <T>(auth: AuthContext, repository: string, host?: string) =>
    call<T>(
      auth,
      `/workspace/ci/links?repository=${encodeURIComponent(repository)}${host ? `&host=${encodeURIComponent(host)}` : ''}`,
      { method: 'DELETE' }
    ),
  // setup-PR — link 로부터 워크플로 YAML 을 합성해 대상 레포에 브랜치+커밋+PR(워크스페이스 GitHub App 토큰). harnesses:read.
  setupCiLinkPr: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/ci/links/setup-pr', { method: 'POST', body: JSON.stringify(body) }),
  // 셀프호스티드 러너(개인 소유 디바이스 페어링). 목록=내(subject) 러너 메타만(토큰 없음).
  // pair 는 평문 토큰(rnr_…)을 1회만 돌려주고(저장은 해시), revoke 는 204(callVoid).
  listRunners: <T>(auth: AuthContext) => call<T>(auth, '/runners'),
  pairRunner: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/runners', { method: 'POST', body: JSON.stringify(body) }),
  revokeRunner: (auth: AuthContext, id: string) =>
    callVoid(auth, `/runners/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 워크스페이스-공유 러너(팀 자원, owner=ws:<workspace>). admin 이 등록(settings:write) → 멤버 누구나 self:ws:<id> 로 타깃.
  // owned=팀 소유 러너만(로스터[GET /workspace/runners]는 개인 러너 포함), pair 는 평문 토큰 1회, revoke 204.
  listWorkspaceOwnedRunners: <T>(auth: AuthContext) => call<T>(auth, '/workspace/runners/owned'),
  // 워크스페이스 러너 로스터(members:read) — 이 워크스페이스에 페어링된 러너 메타. self:ws 풀 노출 판단용.
  listWorkspaceRunners: <T>(auth: AuthContext) => call<T>(auth, '/workspace/runners'),
  pairWorkspaceRunner: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/runners', { method: 'POST', body: JSON.stringify(body) }),
  revokeWorkspaceRunner: (auth: AuthContext, id: string) =>
    callVoid(auth, `/workspace/runners/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // GitHub Actions 러너 자가등록 — 빌드 서버에 GitHub 러너 + Everdict 워크스페이스-공유 러너를 함께 세우는 설치 스크립트 생성.
  githubInstallWorkspaceRunner: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/runners/github-install', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
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
  // 비인증 미리보기(서버가 토큰만 검증) — 링크 랜딩에서 워크스페이스 이름/썸네일 표시. auth 는 있으면 실려가지만 서버가 무시.
  previewInvite: <T>(auth: AuthContext, token: string) =>
    call<T>(auth, `/invites/preview?token=${encodeURIComponent(token)}`),
  // 내 프로필(이름/유저네임/아바타) 수정 — email 은 SSO(읽기전용)라 안 받는다. PATCH /me/profile → 갱신된 프로필.
  updateProfile: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/me/profile', { method: 'PATCH', body: JSON.stringify(body) }),
  // 이 워크스페이스에서 나가기(self-serve). 마지막 admin 이면 409. 204(본문 없음) → callVoid.
  leaveWorkspace: (auth: AuthContext) => callVoid(auth, '/members/me', { method: 'DELETE' }),
}
