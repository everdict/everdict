import 'server-only'

import { env } from '@/shared/config/env'

// Control plane (@everdict/api) HTTP client — server-only calls.
// Auth context: a logged-in user forwards the Keycloak access token verbatim as Authorization: Bearer
// (the control plane decides authentication/authz), and when Keycloak is unset (dev) it falls back to x-everdict-tenant.
// If a workspace is present (= active workspace cookie switched from the sidebar) it's forwarded as x-everdict-workspace to scope to that workspace.
export type AuthContext = ({ bearer: string } | { devTenant: string }) & { workspace?: string }

function authHeaders(auth: AuthContext): Record<string, string> {
  const headers: Record<string, string> =
    'bearer' in auth
      ? { authorization: `Bearer ${auth.bearer}` }
      : { 'x-everdict-tenant': auth.devTenant }
  if (auth.workspace) headers['x-everdict-workspace'] = auth.workspace
  return headers
}

// content-type: application/json is only attached when there's a body. Attaching this header to a body-less DELETE makes
// Fastify treat it as an empty JSON body and throw FST_ERR_CTP_EMPTY_JSON_BODY(400, "body cannot be empty…").
function requestHeaders(auth: AuthContext, init?: RequestInit): Record<string, string> {
  const headers = authHeaders(auth)
  // Normalize and merge caller-specified headers (HeadersInit) — caller values win.
  if (init?.headers) for (const [k, v] of new Headers(init.headers)) headers[k] = v
  if (init?.body != null && headers['content-type'] === undefined)
    headers['content-type'] = 'application/json'
  return headers
}

// Control plane error response → human-readable message. For a flat envelope {code,message}, expose message verbatim (e.g. so a
// friendly message like "can't reach HF" shows up "naturally" on screen). If it's not an envelope, fall back to path/status (for debugging).
function controlPlaneError(path: string, status: number, raw: string): Error {
  try {
    const j = JSON.parse(raw) as { message?: unknown }
    if (typeof j.message === 'string' && j.message.trim()) return new Error(j.message)
  } catch {
    // non-JSON body — fall back below
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

// A call whose FAILURE body matters to the caller — returns the flat error envelope ({code,message,data}) instead
// of throwing it away as a message string. Use only where a specific status carries a payload the UI acts on
// (today: the filesystem's 409 merge kit); everything else stays on `call`.
export interface EnvelopeResult {
  ok: boolean
  status: number
  body: unknown // the parsed JSON body (the resource on success, the error envelope on failure)
}

async function callWithEnvelope(
  auth: AuthContext,
  path: string,
  init?: RequestInit
): Promise<EnvelopeResult> {
  const res = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: requestHeaders(auth, init),
    cache: 'no-store',
  })
  const raw = await res.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    body = { message: raw.slice(0, 300) }
  }
  return { ok: res.ok, status: res.status, body }
}

// 응답이 JSON 이 아니라 바이트인 호출 — 원격 이미지 프록시가 유일한 사용처다. content-type 을 함께 돌려주는 건
// 브라우저에 그대로 넘겨야 하기 때문이다(우리가 추측하면 GitHub 이 준 형식과 어긋난다).
async function callBytes(
  auth: AuthContext,
  path: string,
  init?: RequestInit
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const res = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: requestHeaders(auth, init),
    cache: 'no-store',
  })
  if (!res.ok) throw controlPlaneError(path, res.status, await res.text())
  return {
    bytes: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  }
}

// For 204 (No Content) responses only — mutations with no body where res.json() must not be called (e.g. secret set/delete).
async function callVoid(auth: AuthContext, path: string, init?: RequestInit): Promise<void> {
  const res = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: requestHeaders(auth, init),
    cache: 'no-store',
  })
  if (!res.ok) throw controlPlaneError(path, res.status, await res.text())
}

// 이슈 목록의 좁히기. 행(`listIssues`)과 그룹 개수(`countIssues`)가 같은 문자열을 만들도록 한곳에 둔다 —
// 헤더가 12 라고 하는데 그 아래 목록이 3 줄만 그리는 일은, 두 곳에서 각자 쿼리를 조립할 때 생긴다.
export interface IssueListQuery {
  // 축마다 집합이다: `?status=todo&status=in_progress`. 축끼리는 AND, 축 안에서는 OR.
  status?: string[]
  priority?: string[]
  // 빈 문자열은 「담당자 없음」 — 쿼리 파라미터에 null 이 없어서 그 버킷을 그렇게 부른다.
  assignee?: string[]
  project?: string[]
  cycle?: string[]
  label?: string[]
  team?: string
  mine?: boolean
  // 한 부모의 하위 이슈들, 또는 `none` 으로 최상위만. 자식이 목록에 두 번(자기 줄 + 부모 아래) 나오지
  // 않게 하려면 보드는 후자를 쓴다.
  parent?: string
  triage?: boolean
  linkType?: string
  linkId?: string
  // 이슈를 이름으로 찾는다(식별자·제목의 부분 일치). 피커가 창 하나를 받아 클라이언트에서 거르면
  // 워크스페이스가 그 창보다 커지는 순간 조용히 못 찾기 시작한다 — 그래서 서버가 좁힌다.
  search?: string
  // GitHub 대량 동기화의 작업 집합. 전체 목록을 받아 클라이언트에서 거르는 대신 서버가 좁힌다.
  syncPull?: boolean
  // 아래 셋은 PAGE 만의 것 — 집계에는 장도 순서도 없다.
  order?: string
  limit?: number
  cursor?: string
}

const ISSUE_FACETS = ['status', 'priority', 'assignee', 'project', 'cycle', 'label'] as const

function issueListParams(filter?: IssueListQuery): URLSearchParams {
  const q = new URLSearchParams()
  for (const facet of ISSUE_FACETS) {
    for (const value of filter?.[facet] ?? []) q.append(facet, value)
  }
  if (filter?.team) q.set('team', filter.team)
  if (filter?.mine) q.set('mine', 'true')
  if (filter?.parent) q.set('parent', filter.parent)
  if (filter?.triage !== undefined) q.set('triage', filter.triage ? 'true' : 'false')
  // The reverse lookup ("which issues watch this harness") needs both halves or the route 400s.
  if (filter?.linkType && filter.linkId) {
    q.set('linkType', filter.linkType)
    q.set('linkId', filter.linkId)
  }
  if (filter?.syncPull) q.set('syncPull', 'true')
  if (filter?.search) q.set('q', filter.search)
  return q
}

// The scorecards list's query, as the control plane spells it. Exported because the server component, the
// view action and the "load older" all build one — written twice, the page and its counts would drift.
export interface ScorecardListQuery {
  // Scopes — one value each.
  judge?: string
  schedule?: string
  dataset?: string
  harness?: string
  team?: string
  day?: string
  q?: string
  // Facets — sets. An empty string names the UNSET bucket (no runtime, no creator, no team), because a query
  // string has no null and "none" is a bucket people filter to.
  statuses?: readonly string[]
  datasets?: readonly string[]
  harnesses?: readonly string[]
  runtimes?: readonly string[]
  creators?: readonly string[]
  teams?: readonly string[]
  // The page: a size, and the last row you drew.
  limit?: number
  before?: { createdAt: string; id: string }
}

function scorecardQueryString(query?: ScorecardListQuery): URLSearchParams {
  const q = new URLSearchParams()
  if (query === undefined) return q
  // schedule and judge are mutually exclusive detail-history reads, exactly as the route reads them.
  if (query.schedule) q.set('schedule', query.schedule)
  else if (query.judge) q.set('judge', query.judge)
  if (query.dataset) q.set('dataset', query.dataset)
  if (query.harness) q.set('harness', query.harness)
  // 팀 스코프는 위 좁힘과 결합한다 — "이 중에 우리 팀 것"이 팀 사이드바가 묻는 질문이다.
  if (query.team) q.set('team', query.team)
  if (query.day) q.set('day', query.day)
  if (query.q) q.set('q', query.q)
  for (const [key, values] of [
    ['statuses', query.statuses],
    ['datasets', query.datasets],
    ['harnesses', query.harnesses],
    ['runtimes', query.runtimes],
    ['creators', query.creators],
    ['teams', query.teams],
  ] as const) {
    for (const value of values ?? []) q.append(key, value)
  }
  if (query.limit !== undefined) q.set('limit', String(query.limit))
  if (query.before !== undefined) {
    q.set('beforeCreatedAt', query.before.createdAt)
    q.set('beforeId', query.before.id)
  }
  return q
}

export const controlPlane = {
  me: <T>(auth: AuthContext) => call<T>(auth, '/me'),
  // Notification feed (personally owned; bell inbox) — qs is a raw query string like '?unread=1&limit=30'.
  listNotifications: <T>(auth: AuthContext, qs: string) => call<T>(auth, `/notifications${qs}`),
  readNotifications: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/notifications/read', { method: 'POST', body: JSON.stringify(body) }),
  // Resource comments (datasets etc.) — collaborative discussion. Read=viewer+, create=member+, delete=author-or-admin (control plane enforces).
  listComments: <T>(auth: AuthContext, resourceType: string, resourceId: string) =>
    call<T>(
      auth,
      `/comments?resourceType=${encodeURIComponent(resourceType)}&resourceId=${encodeURIComponent(resourceId)}`
    ),
  createComment: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/comments', { method: 'POST', body: JSON.stringify(body) }),
  deleteComment: (auth: AuthContext, id: string) =>
    callVoid(auth, `/comments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Knowledge graph — the workspace's eval data projected into a queryable node/edge graph (Settings › Knowledge).
  // graph = the whole-workspace projection (read = scorecards:read); reindex = rebuild from records (settings:write).
  knowledgeGraph: <T>(auth: AuthContext, depth?: number) =>
    call<T>(auth, `/knowledge/graph${depth !== undefined ? `?depth=${depth}` : ''}`),
  reindexKnowledge: <T>(auth: AuthContext) =>
    call<T>(auth, '/knowledge/reindex', { method: 'POST' }),
  // Knowledge entries — reified claims (the knowledge layer). List is freshness-decorated; read=scorecards:read,
  // write=comments:write, manage=creator-or-admin (control plane enforces). verify stamps verifiedAt (not an edit).
  // Workspace filesystem — the shared, workspace-isolated file tree (paths travel as query params; the control
  // plane normalizes them and rejects traversal).
  listFsEntries: <T>(auth: AuthContext, path: string) =>
    call<T>(auth, `/fs/entries?path=${encodeURIComponent(path)}`),
  readFsFile: <T>(auth: AuthContext, path: string) =>
    call<T>(auth, `/fs/file?path=${encodeURIComponent(path)}`),
  // The same read, keeping the STATUS: the media route serves these bytes to an <img>/<video>, and a browser
  // cannot tell 404 (the attachment was deleted) from 403 (this reader may not browse files) if both arrive as
  // one generic failure — the network tab is where that question gets answered.
  readFsFileChecked: (auth: AuthContext, path: string) =>
    callWithEnvelope(auth, `/fs/file?path=${encodeURIComponent(path)}`),
  writeFsFile: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/fs/file', { method: 'PUT', body: JSON.stringify(body) }),
  // The same write, keeping a 409's BODY: losing a race to a teammate or an agent is a normal outcome of
  // collaborative editing, not an error to flatten into a string — the resolution kit (live content + the
  // attempted three-way merge) rides in the envelope's `data` and the caller needs it to offer a merge.
  writeFsFileChecked: (auth: AuthContext, body: unknown) =>
    callWithEnvelope(auth, '/fs/file', { method: 'PUT', body: JSON.stringify(body) }),
  // Run one file in a sandbox and get back stdout/stderr/exit code plus whatever it wrote. 404 when the
  // deployment composed no execution driver — the viewer only offers Run when GET /me says it can.
  runFsFile: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/fs/executions', { method: 'POST', body: JSON.stringify(body) }),
  makeFsDirectory: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/fs/directories', { method: 'POST', body: JSON.stringify(body) }),
  moveFsEntry: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/fs/move', { method: 'POST', body: JSON.stringify(body) }),
  removeFsEntry: <T>(auth: AuthContext, path: string, recursive: boolean) =>
    call<T>(
      auth,
      `/fs/entry?path=${encodeURIComponent(path)}${recursive ? '&recursive=true' : ''}`,
      {
        method: 'DELETE',
      }
    ),
  // Publication history of one file — who published each revision, when, and why (retained indefinitely).
  listFsRevisions: <T>(auth: AuthContext, path: string, limit?: number, before?: number) =>
    call<T>(
      auth,
      `/fs/revisions?path=${encodeURIComponent(path)}${limit !== undefined ? `&limit=${limit}` : ''}${
        before !== undefined ? `&before=${before}` : ''
      }`
    ),
  // What changed between two revisions (omit `to` to compare against the live file).
  diffFsRevisions: <T>(auth: AuthContext, path: string, from: number, to?: number) =>
    call<T>(
      auth,
      `/fs/revisions/diff?path=${encodeURIComponent(path)}&from=${from}${to !== undefined ? `&to=${to}` : ''}`
    ),
  readFsRevision: <T>(auth: AuthContext, path: string, revision: number) =>
    call<T>(auth, `/fs/revisions/content?path=${encodeURIComponent(path)}&revision=${revision}`),
  restoreFsRevision: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/fs/revisions/restore', { method: 'POST', body: JSON.stringify(body) }),
  listKnowledgeEntries: <T>(auth: AuthContext) => call<T>(auth, '/knowledge/entries'),
  getKnowledgeEntry: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/knowledge/entries/${encodeURIComponent(id)}`),
  createKnowledgeEntry: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/knowledge/entries', { method: 'POST', body: JSON.stringify(body) }),
  updateKnowledgeEntry: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/knowledge/entries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteKnowledgeEntry: (auth: AuthContext, id: string) =>
    callVoid(auth, `/knowledge/entries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  verifyKnowledgeEntry: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/knowledge/entries/${encodeURIComponent(id)}/verify`, { method: 'POST' }),
  approveKnowledgeEntry: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/knowledge/entries/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  rejectKnowledgeEntry: (auth: AuthContext, id: string) =>
    callVoid(auth, `/knowledge/entries/${encodeURIComponent(id)}/reject`, { method: 'POST' }),
  // Workspace membership (self-serve): my workspace list + create (creator is admin).
  listWorkspaces: <T>(auth: AuthContext) => call<T>(auth, '/workspaces'),
  createWorkspace: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspaces', { method: 'POST', body: JSON.stringify(body) }),
  // Active workspace record (name/logo/owner) read·update·delete. Singular /workspace.
  getWorkspace: <T>(auth: AuthContext) => call<T>(auth, '/workspace'),
  updateWorkspace: <T>(auth: AuthContext, patch: unknown) =>
    call<T>(auth, '/workspace', { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteWorkspace: (auth: AuthContext) => callVoid(auth, '/workspace', { method: 'DELETE' }),
  // scorecardId → that scorecard's per-case child runs (drilldown); all → standalone runs + scorecard children
  // (activity console's all-executions view, grouped in the UI); otherwise the standalone activity list (children hidden).
  listRuns: <T>(
    auth: AuthContext,
    opts?: { scorecardId?: string; all?: boolean; runner?: string; limit?: number; offset?: number }
  ) =>
    call<T>(
      auth,
      opts?.scorecardId
        ? `/runs?scorecardId=${encodeURIComponent(opts.scorecardId)}`
        : opts?.runner
          ? `/runs?runner=${encodeURIComponent(opts.runner)}${opts.limit ? `&limit=${opts.limit}` : ''}${opts.offset ? `&offset=${opts.offset}` : ''}`
          : opts?.all
            ? '/runs?scope=all'
            : '/runs'
    ),
  getRun: <T>(auth: AuthContext, id: string) => call<T>(auth, `/runs/${encodeURIComponent(id)}`),
  // The run's OWNED trajectory (sealed evidence; embed fallback during dual-read — meta.source says which copy served).
  //
  // ── A FIVE-HOUR AGENT'S TRACE IS NOT A PAGE ─────────────────────────────────────────────────────────
  //
  // The route has taken `after` and `limit` since the split-plane read landed, and this caller passed
  // neither — so opening a long-running agent's run meant fetching every event it had ever emitted, parsing
  // each one through a discriminated union, and rendering the lot. The bound existed; nobody asked for it,
  // which is this repo's most-repeated shape (rule `protocol`: a capability the consumer never received).
  //
  // `meta.eventCount` is the SEALED total, not the page length, so a caller can always say "N of M" — and
  // the store refuses a header claiming events it cannot serve, which is what makes that number evidence
  // rather than decoration.
  getRunTrajectory: <T>(
    auth: AuthContext,
    id: string,
    query: { after?: number; limit?: number; emitter?: string } = {}
  ) => {
    const qs = new URLSearchParams()
    if (query.after !== undefined) qs.set('after', String(query.after))
    if (query.limit !== undefined) qs.set('limit', String(query.limit))
    if (query.emitter) qs.set('emitter', query.emitter)
    const suffix = qs.toString()
    return call<T>(auth, `/runs/${encodeURIComponent(id)}/trajectory${suffix ? `?${suffix}` : ''}`)
  },
  // One sealed trajectory from the owned ledger (meta + events). Opens every source — an otlp arrival or a
  // materialized import has no run row, so the run-scoped read above cannot reach it.
  // Paged for the same reason the run-scoped twin is: an INGESTED trace belongs to somebody else's five-hour
  // agent, and this door is the one that opens it. The route has taken `after`/`limit` since the split-plane
  // read landed; passing neither meant the dialog fetched every event before it could draw one.
  getTrajectory: <T>(auth: AuthContext, id: string, query: { after?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (query.after !== undefined) qs.set('after', String(query.after))
    if (query.limit !== undefined) qs.set('limit', String(query.limit))
    const suffix = qs.toString()
    return call<T>(auth, `/trajectories/${encodeURIComponent(id)}${suffix ? `?${suffix}` : ''}`)
  },
  // Browse the workspace's sealed trajectories (the owned evidence ledger, N1 look-inward) — metas only, cursor-paginated.
  listTrajectories: <T>(
    auth: AuthContext,
    query: { limit?: number; cursor?: string; kind?: string } = {}
  ) => {
    const qs = new URLSearchParams()
    if (query.limit !== undefined) qs.set('limit', String(query.limit))
    if (query.cursor) qs.set('cursor', query.cursor)
    if (query.kind) qs.set('kind', query.kind)
    const suffix = qs.toString()
    return call<T>(auth, `/trajectories${suffix ? `?${suffix}` : ''}`)
  },
  // Live-progress log snapshot (the LiveLogs widget polls; found=false = nothing to tail yet).
  // stream: stdout (default, the result stream) | stderr (harness progress logs).
  getRunLogs: <T>(auth: AuthContext, id: string, stream?: 'stdout' | 'stderr') =>
    call<T>(
      auth,
      `/runs/${encodeURIComponent(id)}/logs${stream ? `?stream=${encodeURIComponent(stream)}` : ''}`
    ),
  // 라이브 궤적 스냅숏 (LiveTrace 위젯이 폴링) — 실행 중 쌓이는 TraceEvent 전량(봉인 전 미리보기).
  getRunLiveTrace: <T>(auth: AuthContext, id: string, after?: number) =>
    call<T>(
      auth,
      `/runs/${encodeURIComponent(id)}/trajectory/live${after === undefined ? '' : `?after=${after}`}`
    ),
  // 케이스 배치 조회(런타임 디버깅) — 케이스 잡이 클러스터 안에서 어디까지 갔는지(blocked 용량 판정·노드·이벤트 피드).
  getRunPlacement: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/placement`),
  // 토폴로지 헬스 로스터(서비스 하네스) — 웜 토폴로지의 서비스별 상태(재시작·OOM·최근 이벤트).
  getRunTopology: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/topology`),
  // 토폴로지 서비스 1개의 로그 테일 — "스택은 떠 있는데 케이스가 실패한다"의 서비스 쪽 답.
  getTopologyServiceLogs: <T>(auth: AuthContext, id: string, service: string) =>
    call<T>(
      auth,
      `/runs/${encodeURIComponent(id)}/topology/services/${encodeURIComponent(service)}/logs`
    ),
  // One-shot exec inside a run's live sandbox (SandboxTerminal). Creator-or-admin, enforced by the control plane.
  execInRun: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/exec`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Live screen frame (LiveScreen — os-use desktop). supported=false for other env kinds.
  getRunScreen: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/screen`),
  // Sealed replay recording of a settled run (ReplayPlayer). Creator-or-admin, enforced by the control plane.
  getRunRecording: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/recording`),
  // 멀티플렉스 라이브 SSE(④) — 위젯별 폴러를 대체하는 한 연결. RAW Response를 그대로 반환(BFF가 무버퍼 프록시).
  streamRunLive: (auth: AuthContext, id: string, lanes: string) =>
    fetch(
      `${env.CONTROL_PLANE_URL.replace(/\/$/, '')}/runs/${encodeURIComponent(id)}/live/stream?lanes=${encodeURIComponent(lanes)}`,
      { headers: requestHeaders(auth), cache: 'no-store' }
    ),
  // 러닝 케이스 샌드박스의 라이브 리포 파일 트리(런 워크벤치 탐색기). Creator-or-admin은 컨트롤 플레인이 강제.
  getRunFs: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/fs`),
  // 그 리포의 파일 1개 + 워킹트리 diff(런 워크벤치 에디터 패널).
  getRunFsFile: <T>(auth: AuthContext, id: string, path: string) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/fs/file?path=${encodeURIComponent(path)}`),
  // Interactive run-SCREEN ticket (⑦b) — take over the browser the case is driving. Creator-or-admin, enforced by
  // the control plane, which also 404s a run with nothing attachable.
  runScreenTicket: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/screen-ticket`, { method: 'POST' }),
  // Interactive-terminal ticket (LiveTerminal — observability ⑥). Creator-or-admin, enforced by the control plane.
  terminalTicket: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/terminal-ticket`, { method: 'POST' }),
  // Interactive browser sessions (browser-profiles S1) — personal / self-scoped (owner=subject), enforced by the control plane.
  // body carries an optional { country } (browser-profiles S4) selecting the workspace's egress proxy for the login browser.
  createBrowserSession: <T>(auth: AuthContext, body?: unknown) =>
    call<T>(auth, '/browser-sessions', { method: 'POST', body: JSON.stringify(body ?? {}) }),
  listBrowserSessions: <T>(auth: AuthContext) => call<T>(auth, '/browser-sessions'),
  closeBrowserSession: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/browser-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  browserSessionTicket: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/browser-sessions/${encodeURIComponent(id)}/ticket`, { method: 'POST' }),
  // Live "what a capture would remember" summary (per-domain cookie names; values never cross the wire) — the
  // profile-creation flow polls it to render the remembered-login chips.
  browserSessionStatePreview: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/browser-sessions/${encodeURIComponent(id)}/state-preview`),
  // Saved authenticated browser profiles (browser-profiles S2) — personal / self-scoped, enforced by the control plane.
  createBrowserProfile: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/browser-profiles', { method: 'POST', body: JSON.stringify(body) }),
  listBrowserProfiles: <T>(auth: AuthContext) => call<T>(auth, '/browser-profiles'),
  updateBrowserProfile: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/browser-profiles/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteBrowserProfile: (auth: AuthContext, id: string) =>
    callVoid(auth, `/browser-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Capture an interactive session's login (cookies) into a profile (browser-profiles S3).
  captureBrowserProfile: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/browser-profiles/${encodeURIComponent(id)}/capture`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Warm re-login — seed a profile's saved cookies into an interactive session (browser-profiles).
  restoreBrowserProfile: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/browser-profiles/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Workspace BYO egress proxies (browser-profiles S4) — per-country pool. List = workspace read, register/remove = admin.
  listProxies: <T>(auth: AuthContext) => call<T>(auth, '/workspace/proxies'),
  upsertProxy: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/proxies', { method: 'PUT', body: JSON.stringify(body) }),
  deleteProxy: (auth: AuthContext, name: string) =>
    callVoid(auth, `/workspace/proxies/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  // Work queue snapshot — per-runtime-lane running / waiting (FIFO) / next scheduled fire.
  getQueue: <T>(auth: AuthContext) => call<T>(auth, '/queue'),
  // Scheduler queue entry controls (the REAL control-plane wait queue): kill switch + move-to-front reordering.
  cancelQueueEntry: <T>(auth: AuthContext, entryId: string) =>
    call<T>(auth, `/queue/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' }),
  promoteQueueEntry: <T>(auth: AuthContext, entryId: string) =>
    call<T>(auth, `/queue/entries/${encodeURIComponent(entryId)}/promote`, { method: 'POST' }),
  // Workspace ops report — the SLA-evidence read: the platform's failure share separated from the product's.
  getOpsReport: <T>(auth: AuthContext, window?: { from?: string; to?: string }) => {
    const q = new URLSearchParams()
    if (window?.from) q.set('from', window.from)
    if (window?.to) q.set('to', window.to)
    const qs = q.toString()
    return call<T>(auth, qs ? `/workspace/ops-report?${qs}` : '/workspace/ops-report')
  },
  // Gate audit — every recorded release-gate decision + every override with its stated reason.
  getGateAudit: <T>(auth: AuthContext, window?: { from?: string; to?: string }) => {
    const q = new URLSearchParams()
    if (window?.from) q.set('from', window.from)
    if (window?.to) q.set('to', window.to)
    const qs = q.toString()
    return call<T>(auth, qs ? `/workspace/audit/gates?${qs}` : '/workspace/audit/gates')
  },
  // Cross-batch flake index for one dataset (verdict variance under each batch's own stamped policy).
  getScorecardFlake: <T>(auth: AuthContext, dataset: string, harness?: string) => {
    const q = new URLSearchParams({ dataset })
    if (harness) q.set('harness', harness)
    return call<T>(auth, `/scorecards/flake?${q.toString()}`)
  },
  // Metered billing usage (LLM cost for orchestration + verdict; own-pays runs excluded) — meter-only, never blocks.
  getUsage: <T>(auth: AuthContext) => call<T>(auth, '/usage'),
  // Enforcement budget (BLOCKS runs with 402 once a cap is hit; distinct from meter-only /usage). GET = committed
  // usage + the per-tenant limit; PUT = replace the limit (omitted dimension = unlimited). Both admin (settings:read|write).
  getBudget: <T>(auth: AuthContext) => call<T>(auth, '/budget'),
  setBudget: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/budget', { method: 'PUT', body: JSON.stringify(body) }),
  submitRun: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/runs', { method: 'POST', body: JSON.stringify(body) }),
  // Sandbox sessions (the harness playground) — a held-open container the member submits ad-hoc test cases into.
  // create/list/submitTask keep the ENVELOPE because their statuses are the UI's state machine, not just errors:
  // 404 on create/list means "this deployment composed no sandbox driver" (a friendly callout, never a red toast),
  // and 409 on submit means another task is still running (restore the input, don't lose it).
  createSandbox: (auth: AuthContext, body: unknown) =>
    callWithEnvelope(auth, '/sandboxes', { method: 'POST', body: JSON.stringify(body) }),
  listSandboxes: (auth: AuthContext) => callWithEnvelope(auth, '/sandboxes'),
  getSandbox: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/sandboxes/${encodeURIComponent(id)}`),
  submitSandboxTask: (auth: AuthContext, id: string, body: unknown) =>
    callWithEnvelope(auth, `/sandboxes/${encodeURIComponent(id)}/tasks`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // The 2s poll: events since a cursor into the task's append-only buffer (since omitted = full replay, which is
  // how a remounted panel reconstructs the feed). Serves the sealed trajectory once the task settled.
  readSandboxTaskTrace: <T>(auth: AuthContext, id: string, taskId: string, since?: number) =>
    call<T>(
      auth,
      `/sandboxes/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/trace${
        since !== undefined && since > 0 ? `?since=${since}` : ''
      }`
    ),
  closeSandbox: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/sandboxes/${encodeURIComponent(id)}/close`, { method: 'POST' }),
  // One-shot `sh -c` inside a live session's container (the playground's shell disclosure) — creator-or-admin,
  // enforced by the control plane before anything runs.
  execInSandbox: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/sandboxes/${encodeURIComponent(id)}/exec`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // `team` 은 한 팀 소유의 것만 남긴다 — 소유권이 읽기에 하는 일은 필터이지 403 이 아니다.
  // 팀 사이드바의 하네스·데이터셋·저지가 이 파라미터로 좁혀진다.
  listHarnesses: <T>(auth: AuthContext, team?: string) =>
    call<T>(auth, team ? `/harnesses?team=${encodeURIComponent(team)}` : '/harnesses'),
  // GET /harnesses/:id — a harness's instance version tag list.
  getHarness: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(id)}`),
  // 다른 팀으로 넘기기. 소유는 릴리스가 아니라 대상 자체의 것이라 모든 버전이 함께 옮겨가고, 버전은 새로
  // 찍히지 않는다(내용이 바뀐 게 아니다). 제어 평면이 출발 팀과 도착 팀을 둘 다 인가한다.
  moveCapabilityTeam: <T>(
    auth: AuthContext,
    kind: 'harnesses' | 'harness-templates' | 'datasets' | 'judges' | 'scorecards',
    id: string,
    teamId: string
  ) =>
    call<T>(auth, `/${kind}/${encodeURIComponent(id)}/team`, {
      method: 'POST',
      body: JSON.stringify({ teamId }),
    }),
  // Replace version tags (PUT the whole array; empty array = remove) — free-form labels outside the spec (to distinguish versions). The gate is each entity's
  // content mutation action (harnesses:register / datasets:write / runtimes:write) — the control plane enforces.
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
  // Soft-delete a harness version (tombstone — past scorecard history preserved, future runs fail to resolve). Only the
  // version's registrant or a workspace admin (the control plane enforces). Returns { deleted: true } (a body, so call not callVoid).
  // Whole-harness delete = fan out over every live version in the web (there is no /harnesses/:id endpoint — same per-version-only model as datasets).
  deleteHarnessVersion: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`, {
      method: 'DELETE',
    }),
  // GET /harnesses/:id/:version — resolved HarnessSpec (template + pins). For detail/diagramming.
  getHarnessSpec: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(id)}/${encodeURIComponent(version)}`),
  // GET /harnesses/:id/diff — resolved-spec config diff between two versions (base↔candidate). version can be "latest".
  diffHarness: <T>(auth: AuthContext, id: string, base: string, candidate: string) =>
    call<T>(
      auth,
      `/harnesses/${encodeURIComponent(id)}/diff?base=${encodeURIComponent(base)}&candidate=${encodeURIComponent(candidate)}`
    ),
  // GET /harnesses/:id/:version/instance — raw instance (template reference + pins). For config view / new-version prefill.
  getHarnessInstance: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(id)}/${encodeURIComponent(version)}/instance`),
  // GET /harness-templates/:id/:version — a single template (top-level category) structure spec.
  getHarnessTemplateSpec: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/harness-templates/${encodeURIComponent(id)}/${encodeURIComponent(version)}`),
  // Register/validate an instance (template + pins) — /harnesses is the instance surface.
  registerHarness: <T>(auth: AuthContext, instance: unknown) =>
    call<T>(auth, '/harnesses', { method: 'POST', body: JSON.stringify(instance) }),
  validateHarness: <T>(auth: AuthContext, instance: unknown) =>
    call<T>(auth, '/harnesses/validate', { method: 'POST', body: JSON.stringify(instance) }),
  // Template (top-level category: structure/slots) list/get/register/validate — /harness-templates.
  listHarnessTemplates: <T>(auth: AuthContext) => call<T>(auth, '/harness-templates'),
  getHarnessTemplate: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/harness-templates/${encodeURIComponent(id)}`),
  registerHarnessTemplate: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/harness-templates', { method: 'POST', body: JSON.stringify(spec) }),
  validateHarnessTemplate: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/harness-templates/validate', { method: 'POST', body: JSON.stringify(spec) }),
  // `team` 은 한 팀 소유의 것만 남긴다 — 소유권이 읽기에 하는 일은 필터이지 403 이 아니다.
  // 팀 사이드바의 하네스·데이터셋·저지가 이 파라미터로 좁혀진다.
  listDatasets: <T>(auth: AuthContext, team?: string) =>
    call<T>(auth, team ? `/datasets?team=${encodeURIComponent(team)}` : '/datasets'),
  getDataset: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/datasets/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  // Diff between versions — base↔candidate case additions/deletions/changes + meta changes. version can be "latest".
  diffDataset: <T>(auth: AuthContext, id: string, base: string, candidate: string) =>
    call<T>(
      auth,
      `/datasets/${encodeURIComponent(id)}/diff?base=${encodeURIComponent(base)}&candidate=${encodeURIComponent(candidate)}`
    ),
  createDataset: <T>(auth: AuthContext, dataset: unknown) =>
    call<T>(auth, '/datasets', { method: 'POST', body: JSON.stringify(dataset) }),
  // Register a Terminal-Bench task set as a dataset (standard task-format on-ramp). The control plane maps each task
  // to an EvalCase (image env + instruction + tests-pass) and 400s a task with no resolvable image.
  importTerminalBench: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/datasets/terminal-bench', { method: 'POST', body: JSON.stringify(body) }),
  validateDataset: <T>(auth: AuthContext, dataset: unknown) =>
    call<T>(auth, '/datasets/validate', { method: 'POST', body: JSON.stringify(dataset) }),
  // Bulk soft-delete (tombstone) — pass `versions` to delete specific versions, or omit them to delete the whole dataset
  // (all own live versions). The control plane checks each target creator-or-admin and fails fast (nothing deleted if any
  // is forbidden/absent). A body is sent only when versions are given, so the whole-dataset delete is a bodyless DELETE.
  deleteDatasetVersions: <T>(auth: AuthContext, id: string, versions?: string[]) =>
    call<T>(auth, `/datasets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      ...(versions && versions.length > 0 ? { body: JSON.stringify({ versions }) } : {}),
    }),
  listBenchmarks: <T>(auth: AuthContext) => call<T>(auth, '/benchmarks'),
  // HF Hub dataset search + config/split — so the wizard searches/selects instead of typing a raw id directly.
  searchHfDatasets: <T>(auth: AuthContext, query: string, limit?: number) =>
    call<T>(
      auth,
      `/benchmarks/hf/datasets?q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ''}`
    ),
  hfDatasetSplits: <T>(auth: AuthContext, dataset: string) =>
    call<T>(auth, `/benchmarks/hf/splits?dataset=${encodeURIComponent(dataset)}`),
  // repo data file list — fallback to fetch files directly for datasets the viewer doesn't serve.
  hfDatasetFiles: <T>(auth: AuthContext, dataset: string) =>
    call<T>(auth, `/benchmarks/hf/files?dataset=${encodeURIComponent(dataset)}`),
  // Source preview (raw rows before mapping + detected fields) — the "add benchmark" wizard.
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
  // Scheduled (cron) scorecards — a saved RunScorecardInput + cron expression. Firing (Temporal) is control-plane slice 2.
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
  // Manual "run now" — fire a schedule immediately (one-off). Returns { scorecardId }.
  fireSchedule: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/schedules/${encodeURIComponent(id)}/fire`, { method: 'POST' }),
  // Saved scorecard-analysis View — a named AnalysisConfig (opaque), private|shared. Re-run live against current data on open.
  // Workspace task ledger (agent-teams) — cross-turn, cross-agent coordination tasks.
  listTasks: <T>(auth: AuthContext, status?: string) =>
    call<T>(auth, status ? `/tasks?status=${encodeURIComponent(status)}` : '/tasks'),
  createTask: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/tasks', { method: 'POST', body: JSON.stringify(body) }),
  updateTask: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteTask: (auth: AuthContext, id: string) =>
    callVoid(auth, `/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 팀 — 워크스페이스 안에서 이슈를 소유하고 이름 붙이는 그룹(docs/tracker.md).
  // 읽기 teams:read(viewer+) / 쓰기 teams:write(admin). 목록 읽기가 곧 불변식 복구 지점이라
  // (기본팀이 없으면 서버가 만든다) 첫 진입에서 팀이 비어 보이는 상태는 존재하지 않는다.
  listTeams: <T>(auth: AuthContext, filter?: { mine?: boolean }) =>
    call<T>(auth, filter?.mine ? '/teams?mine=true' : '/teams'),
  getTeam: <T>(auth: AuthContext, id: string) => call<T>(auth, `/teams/${encodeURIComponent(id)}`),
  createTeam: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/teams', { method: 'POST', body: JSON.stringify(body) }),
  updateTeam: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/teams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  setDefaultTeam: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/teams/${encodeURIComponent(id)}/default`, { method: 'POST' }),
  deleteTeam: (auth: AuthContext, id: string) =>
    callVoid(auth, `/teams/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 팀의 보드 — 컬럼 이름·색·순서, 그리고 각 컬럼이 어느 정규 상태인지.
  listWorkflowStates: <T>(auth: AuthContext, teamId: string) =>
    call<T>(auth, `/teams/${encodeURIComponent(teamId)}/states`),
  createWorkflowState: <T>(auth: AuthContext, teamId: string, body: unknown) =>
    call<T>(auth, `/teams/${encodeURIComponent(teamId)}/states`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateWorkflowState: <T>(auth: AuthContext, teamId: string, stateId: string, patch: unknown) =>
    call<T>(auth, `/teams/${encodeURIComponent(teamId)}/states/${encodeURIComponent(stateId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteWorkflowState: (auth: AuthContext, teamId: string, stateId: string) =>
    call<unknown>(
      auth,
      `/teams/${encodeURIComponent(teamId)}/states/${encodeURIComponent(stateId)}`,
      { method: 'DELETE' }
    ),
  listTeamMembers: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/teams/${encodeURIComponent(id)}/members`),
  addTeamMember: <T>(auth: AuthContext, id: string, subject: string) =>
    call<T>(auth, `/teams/${encodeURIComponent(id)}/members`, {
      method: 'POST',
      body: JSON.stringify({ subject }),
    }),
  removeTeamMember: (auth: AuthContext, id: string, subject: string) =>
    callVoid(auth, `/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(subject)}`, {
      method: 'DELETE',
    }),
  // 셀프 서비스 로스터(리니어의 "Join teams") — 자기 자신만 넣고 뺀다. teams:join(member+);
  // 비공개 팀은 404로, 이미 속한 팀 재가입은 409로 서버가 판정한다.
  joinTeam: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/teams/${encodeURIComponent(id)}/join`, { method: 'POST' }),
  leaveTeam: (auth: AuthContext, id: string) =>
    callVoid(auth, `/teams/${encodeURIComponent(id)}/leave`, { method: 'POST' }),
  // The eval tracker (docs/tracker.md) — Initiative ⊃ Project ⊃ Issue, the "why we evaluate" layer over the
  // capabilities. One authz pair for all three (issues:read viewer+ / issues:write member+); delete is
  // additionally creator-or-admin, decided server-side.
  // The workspace label registry an issue's labelIds point at. Read on any page that draws a chip.
  listIssueLabels: <T>(auth: AuthContext) => call<T>(auth, '/issue-labels'),
  createIssueLabel: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/issue-labels', { method: 'POST', body: JSON.stringify(body) }),
  updateIssueLabel: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/issue-labels/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteIssueLabel: (auth: AuthContext, id: string) =>
    call<void>(auth, `/issue-labels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 삭제 전에 "몇 개 이슈에서 떨어져 나가는지"를 보여주기 위한 카운트.
  issueLabelUsage: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/issue-labels/${encodeURIComponent(id)}/usage`),
  // 한 PAGE 를 준다 — `{ items, nextCursor? }`. 행은 축약본(issueSummarySchema)이고, 본문·이력·링크 목록은
  // 상세(`getIssue`)에만 있다. 전체를 훑어야 하는 화면은 `nextCursor` 를 되돌려 넣어 다음 장을 잇는다.
  listIssues: <T>(auth: AuthContext, filter?: IssueListQuery) => {
    const q = issueListParams(filter)
    if (filter?.order) q.set('order', filter.order)
    if (filter?.limit !== undefined) q.set('limit', String(filter.limit))
    if (filter?.cursor) q.set('cursor', filter.cursor)
    const qs = q.toString()
    return call<T>(auth, qs ? `/issues?${qs}` : '/issues')
  },
  // 그룹별 개수 — 묶인 화면의 헤더. 목록과 같은 필터를 받고 별도 엔드포인트인 이유는, 묶인 화면이 그룹마다
  // 한 장씩 들고 있어서 자기 행을 세면 페이지 크기를 되풀이할 뿐이기 때문이다.
  countIssues: <T>(auth: AuthContext, groupBy: string, filter?: IssueListQuery) => {
    const q = issueListParams(filter)
    q.set('groupBy', groupBy)
    return call<T>(auth, `/issues/counts?${q.toString()}`)
  },
  getIssue: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/issues/${encodeURIComponent(id)}`),
  createIssue: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/issues', { method: 'POST', body: JSON.stringify(body) }),
  updateIssue: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/issues/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  // Every workflow move goes here — the control plane picks the transition (move / resolve / reopen) that fits
  // the issue's current state, and an illegal one comes back as the domain's 400/409.
  setIssueStatus: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/issues/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // 팀 이동 — 상태 이동과 같은 이유로 전용 엔드포인트다: 식별자를 다시 찍는 전이라서, 이름 바꾸기 곁다리로
  // 일어나면 안 된다. 응답의 identifier 가 새 이름이다(예전 이름도 계속 해석된다).
  // 프로젝트 업데이트 — 트래커가 기록하는 유일한 판단(판정 + 그렇게 읽히는 이유).
  postProjectUpdate: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/projects/${encodeURIComponent(id)}/updates`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listProjectUpdates: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/projects/${encodeURIComponent(id)}/updates`),
  addProjectMilestone: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/projects/${encodeURIComponent(id)}/milestones`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeProjectMilestone: <T>(auth: AuthContext, id: string, milestoneId: string) =>
    call<T>(
      auth,
      `/projects/${encodeURIComponent(id)}/milestones/${encodeURIComponent(milestoneId)}`,
      { method: 'DELETE' }
    ),
  // --- 사이클(팀 이터레이션) ---
  listCycles: <T>(
    auth: AuthContext,
    filter?: { team?: string; open?: boolean; limit?: number }
  ) => {
    const q = new URLSearchParams()
    if (filter?.team) q.set('team', filter.team)
    if (filter?.open) q.set('open', 'true')
    if (filter?.limit !== undefined) q.set('limit', String(filter.limit))
    const qs = q.toString()
    return call<T>(auth, `/cycles${qs ? `?${qs}` : ''}`)
  },
  getCycle: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/cycles/${encodeURIComponent(id)}`),
  createCycle: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/cycles', { method: 'POST', body: JSON.stringify(body) }),
  updateCycle: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/cycles/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  // 종료는 게이트가 아니다 — 남은 일은 이월 대상 사이클로 함께 넘어간다.
  completeCycle: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/cycles/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteCycle: (auth: AuthContext, id: string) =>
    call<unknown>(auth, `/cycles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 트리아지 — 워크플로 앞의 인박스에서 나가는 두 길.
  acceptTriage: <T>(auth: AuthContext, id: string, status: string) =>
    call<T>(auth, `/issues/${encodeURIComponent(id)}/triage/accept`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
  declineTriage: <T>(auth: AuthContext, id: string, note?: string) =>
    call<T>(auth, `/issues/${encodeURIComponent(id)}/triage/decline`, {
      method: 'POST',
      body: JSON.stringify(note !== undefined ? { note } : {}),
    }),
  moveIssue: <T>(auth: AuthContext, id: string, teamId: string) =>
    call<T>(auth, `/issues/${encodeURIComponent(id)}/team`, {
      method: 'POST',
      body: JSON.stringify({ teamId }),
    }),
  addIssueLink: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/issues/${encodeURIComponent(id)}/links`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeIssueLink: <T>(auth: AuthContext, id: string, type: string, linkId: string) =>
    call<T>(
      auth,
      `/issues/${encodeURIComponent(id)}/links/${encodeURIComponent(type)}/${encodeURIComponent(linkId)}`,
      { method: 'DELETE' }
    ),
  // The issue's evaluation history: pinned evidence ∪ every batch its linked datasets/harnesses ran.
  listIssueScorecards: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/issues/${encodeURIComponent(id)}/scorecards`),
  deleteIssue: (auth: AuthContext, id: string) =>
    callVoid(auth, `/issues/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // GitHub import + MANUAL two-way sync for tracker issues (docs/tracker.md). Everdict stays the CLIENT: there is
  // no inbound webhook and no periodic sweep, so a pull happens only when someone asks for one and a push happens
  // as the effect of a local transition. All of these are issues:write (importing and syncing mutate the tracker).
  // The candidate list rides the workspace GitHub App's installation scope, so a repo the App is not on is a 404.
  listIssueImportCandidates: <T>(
    auth: AuthContext,
    filter: { repository: string; host?: string; state?: string }
  ) => {
    const q = new URLSearchParams({ repository: filter.repository })
    if (filter.host) q.set('host', filter.host)
    if (filter.state) q.set('state', filter.state)
    return call<T>(auth, `/issues/import/candidates?${q.toString()}`)
  },
  // 201 { created, skipped } — idempotent by the remote identity, so a number already imported comes back as a
  // skip rather than a duplicate. The skips are the caller's to surface; they are not an error.
  importIssues: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/issues/import', { method: 'POST', body: JSON.stringify(body) }),
  // Bulk pull over one repo's pull-enabled copies — one outcome row per issue, and a single issue's failure is
  // recorded on that row instead of failing the batch.
  pullIssueRepository: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/issues/sync', { method: 'POST', body: JSON.stringify(body) }),
  pullIssue: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/issues/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  setIssueGithubSync: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/issues/${encodeURIComponent(id)}/github`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // Detach drops the remote link only — the local issue and its whole history stay.
  detachIssueGithub: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/issues/${encodeURIComponent(id)}/github`, { method: 'DELETE' }),
  // 이슈 본문·코멘트에 박힌 GitHub 첨부 이미지의 바이트. GHE 첨부(그리고 비공개 리포 첨부)는 리포와 똑같은 인증
  // 뒤에 있고 이 화면을 보는 브라우저에는 그 세션이 없다 — 그래서 컨트롤플레인이 워크스페이스 App 설치로 대신
  // 받아온다. 이슈:read 한 번으로 게이트되고, url 은 저쪽에서 그 이슈의 GitHub 호스트로 고정 검사된다.
  getIssueAttachment: (auth: AuthContext, id: string, url: string) =>
    callBytes(auth, `/issues/${encodeURIComponent(id)}/attachment?url=${encodeURIComponent(url)}`),
  // `team` is derived server-side (a project has no team of its own — it means "the projects this team has
  // issues in"), which is why the sidebar's per-team Projects entry can be a plain query param.
  listProjects: <T>(
    auth: AuthContext,
    filter?: { status?: string; initiative?: string; team?: string; limit?: number }
  ) => {
    const q = new URLSearchParams()
    if (filter?.status) q.set('status', filter.status)
    if (filter?.initiative) q.set('initiative', filter.initiative)
    if (filter?.team) q.set('team', filter.team)
    if (filter?.limit !== undefined) q.set('limit', String(filter.limit))
    const qs = q.toString()
    return call<T>(auth, qs ? `/projects?${qs}` : '/projects')
  },
  // The detail carries the issue rollup (derived per read); the list stays lean.
  getProject: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/projects/${encodeURIComponent(id)}`),
  createProject: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  // Completion is a GATE: with open issues the control plane refuses with a 409 whose `data.openIssues` is the
  // blocker count the confirmation has to name. Keeping the envelope is the point — flattening the refusal to a
  // message would leave the UI guessing, and force must stay an explicit second decision, never a silent retry.
  setProjectStatus: (auth: AuthContext, id: string, body: unknown) =>
    callWithEnvelope(auth, `/projects/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // 409 while the project still holds issues (deleting would orphan them) — move them first.
  deleteProject: (auth: AuthContext, id: string) =>
    callVoid(auth, `/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listInitiatives: <T>(auth: AuthContext, filter?: { status?: string; limit?: number }) => {
    const q = new URLSearchParams()
    if (filter?.status) q.set('status', filter.status)
    if (filter?.limit !== undefined) q.set('limit', String(filter.limit))
    const qs = q.toString()
    return call<T>(auth, qs ? `/initiatives?${qs}` : '/initiatives')
  },
  // The detail carries how far along the goal is (progress over every project's issues) — a fan-out the list
  // omits.
  getInitiative: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/initiatives/${encodeURIComponent(id)}`),
  // 목표 자체에 올라온 판정 — 프로젝트 업데이트와 같은 계약, 한 층 위.
  postInitiativeUpdate: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/initiatives/${encodeURIComponent(id)}/updates`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listInitiativeUpdates: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/initiatives/${encodeURIComponent(id)}/updates`),
  createInitiative: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/initiatives', { method: 'POST', body: JSON.stringify(body) }),
  updateInitiative: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/initiatives/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  // The completion gate — same 409-carrying-the-count contract as a project completion.
  setInitiativeStatus: (auth: AuthContext, id: string, body: unknown) =>
    callWithEnvelope(auth, `/initiatives/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteInitiative: (auth: AuthContext, id: string) =>
    callVoid(auth, `/initiatives/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 프로덕트 타임라인(docs/architecture/product-timeline.md) — "무엇을 배포하는가"의 축.
  listProducts: <T>(auth: AuthContext) => call<T>(auth, '/products'),
  getProduct: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/products/${encodeURIComponent(id)}`),
  // 서버가 스토어를 합성해 주는 타임라인 한 방 read — 릴리즈 + 버전 원장 + 시리즈 포인트 + 이슈 마커.
  getProductTimeline: <T>(
    auth: AuthContext,
    id: string,
    window?: { from?: string; to?: string }
  ) => {
    const q = new URLSearchParams()
    if (window?.from) q.set('from', window.from)
    if (window?.to) q.set('to', window.to)
    const qs = q.toString()
    return call<T>(
      auth,
      qs
        ? `/products/${encodeURIComponent(id)}/timeline?${qs}`
        : `/products/${encodeURIComponent(id)}/timeline`
    )
  },
  createProduct: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/products', { method: 'POST', body: JSON.stringify(body) }),
  updateProduct: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/products/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteProduct: (auth: AuthContext, id: string) =>
    callVoid(auth, `/products/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 지금 GitHub 을 당겨온다 — 첫 싱크는 백필(조용), 그 뒤의 새 버전이 워치 시리즈를 돌린다.
  syncProduct: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/products/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  // 품질 축의 수동 문 — Sync 가 버전 축을 당긴다면 이쪽은 시리즈를 지금 평가한다. keys 없음 = 프로덕트가
  // 지금 지켜보는 전부.
  runProductSeries: <T>(auth: AuthContext, id: string, keys?: string[]) =>
    call<T>(auth, `/products/${encodeURIComponent(id)}/series/run`, {
      method: 'POST',
      body: JSON.stringify(keys !== undefined ? { keys } : {}),
    }),
  createRelease: <T>(auth: AuthContext, productId: string, body: unknown) =>
    call<T>(auth, `/products/${encodeURIComponent(productId)}/releases`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // 추적 서비스가 가리킬 수 있는 레포들 — 워크스페이스 GitHub App 설치 레포(= 싱크가 토큰을 받을 수 있는
  // 정확히 그 집합). 비어 있으면 App 미설치.
  listProductRepoOptions: <T>(auth: AuthContext) => call<T>(auth, '/products/repo-options'),
  // 레포 하나를 읽어 "이 제품은 무엇으로 구성되는가"를 답한다 — 발행 중인 버전 스트림 + 트리의 배포 단위 +
  // 그걸 합친 서비스 제안. 아무것도 저장하지 않는다(위자드가 고르게 하는 근거 read).
  discoverProductRepo: <T>(auth: AuthContext, body: { repository: string; host?: string }) =>
    call<T>(auth, '/products/discover', { method: 'POST', body: JSON.stringify(body) }),
  // 워크스페이스 전체 릴리즈(피커의 read) — ?product= 로 한 프로덕트로 좁힐 수 있다.
  listReleases: <T>(auth: AuthContext, product?: string) =>
    call<T>(auth, product ? `/releases?product=${encodeURIComponent(product)}` : '/releases'),
  getRelease: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/releases/${encodeURIComponent(id)}`),
  updateRelease: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/releases/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  // 릴리즈 게이트 — 열린 링크 이슈/회귀 시리즈를 이고 오는 409 계약(force 로만 넘는다).
  setReleaseStatus: (auth: AuthContext, id: string, body: unknown) =>
    callWithEnvelope(auth, `/releases/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteRelease: (auth: AuthContext, id: string) =>
    callVoid(auth, `/releases/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
  // Capture the View's numbers onto the workspace filesystem (views/<id>/<capturedAt>.json). The captures are
  // ordinary files, so they are listed back with listFsEntries — there is no view-snapshot read endpoint.
  captureViewSnapshot: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/views/${encodeURIComponent(id)}/snapshots`, { method: 'POST' }),
  // filter.judge = only batches that applied this Agent Judge (the judge detail's evaluation history);
  // filter.schedule = only the runs a schedule fired (the schedule detail's run history);
  // filter.dataset / filter.harness = every batch that exercised a capability (the tracker's evaluation history).
  // The scorecards LIST. Two shapes of narrow, deliberately distinct on the wire:
  //  · the SCOPES a detail-history read asks with (a judge's evaluations, a schedule's runs, one team's page)
  //  · the FACETS a list's filter menu asks with — sets, repeated keys, "any of these"
  // …plus the page. Absent `limit` this is the unbounded read it has always been.
  listScorecards: <T>(auth: AuthContext, query?: ScorecardListQuery) => {
    const qs = scorecardQueryString(query).toString()
    return call<T>(auth, qs ? `/scorecards?${qs}` : '/scorecards')
  },
  // How many batches per bucket under the SAME narrow — the total and the group headers a page cannot know.
  countScorecards: <T>(auth: AuthContext, groupBy: string, query?: ScorecardListQuery) => {
    const q = scorecardQueryString(query)
    // Never the page's own bounds: a count narrowed by the cursor answers the page size back.
    q.delete('limit')
    q.delete('beforeCreatedAt')
    q.delete('beforeId')
    q.set('groupBy', groupBy)
    return call<T>(auth, `/scorecards/counts?${q.toString()}`)
  },
  getScorecard: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/scorecards/${encodeURIComponent(id)}`),
  // 오프로드된 분석 아티팩트(요약+케이스별 verdict/scores)를 컨트롤플레인이 오브젝트스토어에서 읽어 JSON 으로 준다.
  // 브라우저가 오브젝트스토어를 직접 치지 않는 이유 = 저장된 ref 는 서버 내부 주소(minio:9000)이고 presigned 라 만료된다.
  getScorecardAnalysis: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/scorecards/${encodeURIComponent(id)}/analysis`),
  runScorecard: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/scorecards', { method: 'POST', body: JSON.stringify(body) }),
  retryScorecard: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/scorecards/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  // Full re-run (전체 재실행) — a new scorecard re-running the source's ENTIRE case set, optionally with a re-score
  // override (grading plan / judge model / trace sink) in the body. Distinct from retry (failed-only, carry-over).
  rerunScorecard: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/scorecards/${encodeURIComponent(id)}/rerun`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Stop a running/queued batch — marks it cancelled and force-frees the runtime of the in-flight cases.
  cancelScorecard: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/scorecards/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  // Re-score ONLY the retryable-unmeasured judge scores in place (transient judge blips) — no case re-run.
  rescoreScorecardUnmeasured: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/scorecards/${encodeURIComponent(id)}/rescore-unmeasured`, { method: 'POST' }),
  // Hard-delete a TERMINAL scorecard (record + child runs) — the batch's creator or a workspace admin; the
  // control plane enforces (403), and an in-flight batch is a 409 (stop it first). Returns { deleted: true }.
  deleteScorecard: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/scorecards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  ingestScorecard: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/scorecards/ingest', { method: 'POST', body: JSON.stringify(body) }),
  ingestScorecardPull: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/scorecards/ingest/pull', { method: 'POST', body: JSON.stringify(body) }),
  diffScorecards: <T>(auth: AuthContext, baseline: string, candidate: string) =>
    call<T>(
      auth,
      `/scorecards/diff?baseline=${encodeURIComponent(baseline)}&candidate=${encodeURIComponent(candidate)}`
    ),
  // Time-range trend / regression-over-time: a single (dataset, metric)'s scorecard time series + regressions vs baseline.
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
  // Per-benchmark leaderboard: a single dataset's (harness × model) ranking (metric descending). window=latest (default)|best.
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
  // Agent Judges (workspace-owned + _shared defaults) — model (LLM/VLM call) | harness (delegate to an agent).
  // Read judges:read (viewer+), register/validate judges:write (member+) — the control plane enforces.
  // `team` 은 한 팀 소유의 것만 남긴다 — 소유권이 읽기에 하는 일은 필터이지 403 이 아니다.
  // 팀 사이드바의 하네스·데이터셋·저지가 이 파라미터로 좁혀진다.
  listJudges: <T>(auth: AuthContext, team?: string) =>
    call<T>(auth, team ? `/judges?team=${encodeURIComponent(team)}` : '/judges'),
  getJudge: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/judges/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  // GET /judges/:id/diff — field-level diff between two judge versions (base↔candidate). version can be "latest".
  diffJudge: <T>(auth: AuthContext, id: string, base: string, candidate: string) =>
    call<T>(
      auth,
      `/judges/${encodeURIComponent(id)}/diff?base=${encodeURIComponent(base)}&candidate=${encodeURIComponent(candidate)}`
    ),
  createJudge: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/judges', { method: 'POST', body: JSON.stringify(spec) }),
  // Soft-delete a judge version (tombstone — past scorecard history preserved, future scorecards fail to resolve). Only the
  // version's registrant or a workspace admin (the control plane enforces). Returns { deleted: true } (a body, so call not callVoid).
  // Whole-judge delete = fan out over every live version in the web (there is no /judges/:id endpoint — same per-version-only model as harnesses).
  deleteJudgeVersion: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/judges/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`, {
      method: 'DELETE',
    }),
  validateJudge: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/judges/validate', { method: 'POST', body: JSON.stringify(spec) }),
  // Preview a (draft) judge against sample evidence — the exact prompt + coverage, NO model call (judges:read).
  previewJudge: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/judges/preview', { method: 'POST', body: JSON.stringify(body) }),
  // Dry-run a (draft) judge — actually runs it (one model call, one case) and returns the real scores (scorecards:run).
  tryJudge: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/judges/try', { method: 'POST', body: JSON.stringify(body) }),
  // Rubrics (versioned judging criteria) — a judge references {id, version} instead of freezing the text into its
  // own version. Same gates as judges (judges:read / judges:write) — no new authz action.
  listRubrics: <T>(auth: AuthContext) => call<T>(auth, '/rubrics'),
  getRubric: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/rubrics/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  createRubric: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/rubrics', { method: 'POST', body: JSON.stringify(spec) }),
  validateRubric: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/rubrics/validate', { method: 'POST', body: JSON.stringify(spec) }),
  setRubricVersionTags: <T>(auth: AuthContext, id: string, version: string, tags: string[]) =>
    call<T>(
      auth,
      `/rubrics/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/tags`,
      {
        method: 'PUT',
        body: JSON.stringify({ tags }),
      }
    ),
  listRuntimes: <T>(auth: AuthContext) => call<T>(auth, '/runtimes'),
  getRuntime: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/runtimes/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  createRuntime: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/runtimes', { method: 'POST', body: JSON.stringify(spec) }),
  validateRuntime: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/runtimes/validate', { method: 'POST', body: JSON.stringify(spec) }),
  // Connection test (live) — verify cluster reachability/auth only, with no job. Credentials are resolved by the control plane from secrets.
  probeRuntime: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/runtimes/probe', { method: 'POST', body: JSON.stringify(spec) }),
  // Live cluster view (read) — nodes/capacity/workload/stores of a registered nomad/k8s runtime; no job. Credentials resolved server-side.
  inspectRuntime: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(
      auth,
      `/runtimes/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/inspect`
    ),
  // Destructive live-cluster control (admin, runtimes:control) — stop/reclaim/purge/cordon. The command is a discriminated action.
  controlRuntime: <T>(auth: AuthContext, id: string, version: string, command: unknown) =>
    call<T>(
      auth,
      `/runtimes/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/control`,
      { method: 'POST', body: JSON.stringify(command) }
    ),
  // Models (workspace-owned + _shared) — a first-class LLM model (provider + underlying model + baseUrl + apiKeySecret
  // NAME), referenced by id from a judge/harness so the agent server gets its whole connection (incl. the linked key)
  // injected instead of a hand-wired env combo. Read models:read (viewer+), register/validate models:write (member+).
  listModels: <T>(auth: AuthContext) => call<T>(auth, '/models'),
  getModel: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/models/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  createModel: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/models', { method: 'POST', body: JSON.stringify(spec) }),
  validateModel: <T>(auth: AuthContext, spec: unknown) =>
    call<T>(auth, '/models/validate', { method: 'POST', body: JSON.stringify(spec) }),
  // Fire a dummy completion against a connection (provider/model/baseUrl/apiKeySecret NAME) → response preview or reason.
  // Gates a register/edit and powers the per-row reachability check. models:write.
  testModelConnection: <T>(auth: AuthContext, connection: unknown) =>
    call<T>(auth, '/models/test-connection', { method: 'POST', body: JSON.stringify(connection) }),
  // Version-free save/edit upsert (PUT /models/:id): a new id → 1.0.0; a changed connection auto patch-bumps a new
  // immutable version; an unchanged one is a no-op. The id is the path; the version is assigned server-side. models:write.
  saveModel: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/models/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // Bulk soft-delete (tombstone) — pass `versions` to delete specific versions, or omit them to delete the whole model
  // (all own live versions). The control plane checks each target creator-or-admin and fails fast (nothing deleted if any
  // is forbidden/absent). A body is sent only when versions are given, so the whole-model delete is a bodyless DELETE.
  deleteModelVersions: <T>(auth: AuthContext, id: string, versions?: string[]) =>
    call<T>(auth, `/models/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      ...(versions && versions.length > 0 ? { body: JSON.stringify({ versions }) } : {}),
    }),
  // Workspace agent — the conversational assistant's configuration (instructions + MCP tool servers + model override).
  // A workspace registers an agent (under a stable id, "default") to plug its own context + tools into the shared agent
  // framework. Read agents:read (viewer+); save/register agents:write (member+). saveAgent = version-free upsert (PUT).
  listAgents: <T>(auth: AuthContext) => call<T>(auth, '/agents'),
  // Subscriptions — the E3 registry (event → reaction rules under governance).
  listSubscriptions: <T>(auth: AuthContext) => call<T>(auth, '/subscriptions'),
  createSubscription: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/subscriptions', { method: 'POST', body: JSON.stringify(body) }),
  updateSubscription: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/subscriptions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteSubscription: (auth: AuthContext, id: string) =>
    call<void>(auth, `/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importAgentTriggers: <T>(auth: AuthContext) =>
    call<T>(auth, '/subscriptions/import-agent-triggers', { method: 'POST' }),
  getAgent: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/agents/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  // 플랫폼 이벤트 로그(라이프사이클 사실, 최신순) — 크래프팅 스튜디오의 리플레이 피커. events:read(viewer+).
  listPlatformEvents: <T>(auth: AuthContext, limit = 20) => call<T>(auth, `/events?limit=${limit}`),
  // 워크스페이스 펄스 — 홈 화면의 단 한 번의 읽기(현황 + 추이). 지표를 목록 여덟 개에서 조립하지 않는 이유는
  // 왕복 여덟 번 때문만이 아니라, 그 산식이 서버 것이기 때문이다(웹이 다시 구현하면 두 곳이 갈라진다).
  getWorkspacePulse: <T>(auth: AuthContext, days?: number) =>
    call<T>(auth, days === undefined ? '/workspace/pulse' : `/workspace/pulse?days=${days}`),
  saveAgent: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/agents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // The built-in (first-party) default tools catalog — powers the Settings › Agent built-in-tools toggles.
  listAgentDefaults: <T>(auth: AuthContext) => call<T>(auth, '/agents/defaults'),
  // 로그인한 멤버 자신의 에이전트 도구셋(Settings › Agent › Tools). 워크스페이스 AgentSpec 이 기준선이고 각 멤버가
  // 자기 on/off 를 얹는다 — 셀프 스코프(개인 시크릿과 동형)라 별도 역할 게이트 없음. setAgentTool 의 enabled=null 은
  // 오버라이드 해제(= 워크스페이스 기본값 따르기).
  listAgentTools: <T>(auth: AuthContext) => call<T>(auth, '/agent/tools'),
  setAgentTool: <T>(auth: AuthContext, key: string, enabled: boolean | null) =>
    call<T>(auth, '/agent/tools', { method: 'PUT', body: JSON.stringify({ key, enabled }) }),
  // 도구 상세 — 목록 행 뒤의 설명(도달 방식·모델이 부르는 function·시크릿·출처). 키에 `:`/`/`가 들어가므로 인코딩한다.
  getAgentTool: <T>(auth: AuthContext, key: string) =>
    call<T>(auth, `/agent/tools/${encodeURIComponent(key)}`),
  // 연결 테스트 — 내 바인딩된 시크릿으로 실제 접속해 서버가 진짜 제공하는 function 을 확인(원격 HTTP MCP 만).
  probeAgentTool: <T>(auth: AuthContext, key: string) =>
    call<T>(auth, `/agent/tools/${encodeURIComponent(key)}/probe`, { method: 'POST' }),
  // 시크릿 바인딩 — 값이 아니라 이름을 잇는다. 워크스페이스 AgentSpec 편집이라 agents:write.
  bindAgentToolSecrets: <T>(auth: AuthContext, key: string, bindings: Record<string, string>) =>
    call<T>(auth, `/agent/tools/${encodeURIComponent(key)}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ bindings }),
    }),
  // 같은 오버레이의 스킬 채널 — 워크스페이스 라이브러리가 "지원하는 절차", 이건 "내 에이전트가 따르는 절차".
  listAgentSkills: <T>(auth: AuthContext) => call<T>(auth, '/agent/skills'),
  setAgentSkill: <T>(auth: AuthContext, key: string, enabled: boolean | null) =>
    call<T>(auth, '/agent/skills', { method: 'PUT', body: JSON.stringify({ key, enabled }) }),
  // The same overlay's model channel — MY default LLM (Account › Preferences). The read carries the workspace
  // baseline beside the pick, and model=null clears the pick (= follow the workspace agent's model again).
  getAgentModel: <T>(auth: AuthContext) => call<T>(auth, '/agent/model'),
  setAgentModel: <T>(auth: AuthContext, model: string | null) =>
    call<T>(auth, '/agent/model', { method: 'PUT', body: JSON.stringify({ model }) }),
  // Workspace Skills — SKILL.md-style procedures the members author for the conversational agent (dual-scoped
  // private|workspace). Read skills:read (viewer+); author/edit/share/delete skills:write (member+, creator-or-admin
  // for a specific skill). generateSkill drafts a skill from a description via the workspace's model (skill-generate).
  listSkills: <T>(auth: AuthContext) => call<T>(auth, '/skills'),
  getSkill: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/skills/${encodeURIComponent(id)}`),
  createSkill: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/skills', { method: 'POST', body: JSON.stringify(body) }),
  updateSkill: <T>(auth: AuthContext, id: string, patch: unknown) =>
    call<T>(auth, `/skills/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteSkill: (auth: AuthContext, id: string) =>
    callVoid(auth, `/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  generateSkill: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/skills/generate', { method: 'POST', body: JSON.stringify(body) }),
  // 스토어 발행물(everdict 예제 / 다른 워크스페이스 발행)을 이 워크스페이스 라이브러리로 **복사**한다 —
  // 가져온 뒤에는 직접 쓴 스킬과 완전히 같다(편집·버전 찍기 모두 여기서). skills:write.
  importSkill: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/skills/import', { method: 'POST', body: JSON.stringify(body) }),
  // 스킬의 버전 라인 — 지금 내용을 한 버전으로 "찍고"(stamp), 찍힌 버전은 불변으로 남는다.
  listSkillVersions: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/skills/${encodeURIComponent(id)}/versions`),
  getSkillVersion: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  stampSkillVersion: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/skills/${encodeURIComponent(id)}/versions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Capability Store — 한 판별자 엔티티(mcp|code|skill)를 저작·발행·채택. read capabilities:read(viewer+);
  // save/reach/delete capabilities:write(member+, 특정 capability 는 owner-or-admin, public 승격은 admin).
  listCapabilities: <T>(auth: AuthContext) => call<T>(auth, '/capabilities'),
  listPublicCapabilities: <T>(auth: AuthContext) => call<T>(auth, '/capabilities/public'),
  getCapability: <T>(auth: AuthContext, id: string, version?: string, source?: string) => {
    const q = new URLSearchParams()
    if (source) q.set('source', source)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return call<T>(
      auth,
      version
        ? `/capabilities/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}${suffix}`
        : `/capabilities/${encodeURIComponent(id)}${suffix}`
    )
  },
  // 버전 관리(레지스트리 엔티티 패리티) — 버전 목록·구조 diff·버전 태그(생성자-or-admin). source=크로스테넌트 public/subset 오너.
  listCapabilityVersions: <T>(auth: AuthContext, id: string, source?: string) =>
    call<T>(
      auth,
      `/capabilities/${encodeURIComponent(id)}/versions${source ? `?source=${encodeURIComponent(source)}` : ''}`
    ),
  diffCapabilityVersions: <T>(
    auth: AuthContext,
    id: string,
    base: string,
    candidate: string,
    source?: string
  ) => {
    const q = new URLSearchParams({ base, candidate })
    if (source) q.set('source', source)
    return call<T>(auth, `/capabilities/${encodeURIComponent(id)}/diff?${q.toString()}`)
  },
  setCapabilityVersionTags: <T>(auth: AuthContext, id: string, version: string, tags: string[]) =>
    call<T>(
      auth,
      `/capabilities/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/tags`,
      { method: 'PUT', body: JSON.stringify({ tags }) }
    ),
  saveCapability: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/capabilities/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  setCapabilityVisibility: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/capabilities/${encodeURIComponent(id)}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteCapabilityVersion: (auth: AuthContext, id: string, version: string) =>
    callVoid(
      auth,
      `/capabilities/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`,
      {
        method: 'DELETE',
      }
    ),
  // Capability wizard helpers — validate (dry-run save: predict version + image warnings) + mcp probe (test-connect a
  // URL and discover its tools) + image tags (environment picker). capabilities:write / harnesses:read (control plane).
  validateCapability: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/capabilities/validate', { method: 'POST', body: JSON.stringify(body) }),
  probeCapabilityMcp: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/capabilities/probe-mcp', { method: 'POST', body: JSON.stringify(body) }),
  listImageTags: <T>(auth: AuthContext, repository: string, registry?: string) =>
    call<T>(
      auth,
      `/workspace/image-registries/tags?repository=${encodeURIComponent(repository)}${registry ? `&registry=${encodeURIComponent(registry)}` : ''}`
    ),
  // GET /workspace/image-registries/verify — 이 워크스페이스가 그 ref 를 실제로 pull 할 수 있는지(+ digest).
  // 실패는 에러가 아니라 결과(pullable:false + reason) — 저작 화면이 배지로 렌더한다.
  verifyImage: <T>(auth: AuthContext, image: string) =>
    call<T>(auth, `/workspace/image-registries/verify?image=${encodeURIComponent(image)}`),
  getWorkspaceSettings: <T>(auth: AuthContext) => call<T>(auth, '/workspace/settings'),
  setWorkspaceSettings: <T>(auth: AuthContext, patch: unknown) =>
    call<T>(auth, '/workspace/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  // Workspace secrets (model/provider keys + cluster credentials) — values are never returned (list = name + updatedAt).
  // At-rest encryption is the control plane's SecretStore. set/delete return 204 (no body) → callVoid.
  listSecrets: <T>(auth: AuthContext) => call<T>(auth, '/secrets'),
  // Workspace secrets + their live usage sites (which registry specs / settings integrations reference each by name).
  // Admin-only (secrets:read); refs=[] = an orphan (referenced nowhere). Computed fresh — a removed reference disappears.
  listSecretUsage: <T>(auth: AuthContext) => call<T>(auth, '/secrets/usage'),
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
  // Register an offline-token secret — a stored OAuth refresh token the control plane exchanges for a short-lived
  // access token on use. The control plane performs one refresh-token grant to validate it + compute the first expiry
  // (a bad grant surfaces as an error), then returns the secret metadata (incl. accessTokenExpiresAt). Tokens are never returned.
  setOfflineToken: <T>(
    auth: AuthContext,
    name: string,
    grant: {
      tokenUrl: string
      clientId: string
      clientSecret?: string
      refreshToken: string
      scope?: string
    },
    scope: 'user' | 'workspace' = 'workspace'
  ) =>
    call<T>(auth, `/secrets/${encodeURIComponent(name)}/offline-token`, {
      method: 'PUT',
      body: JSON.stringify({ grant, scope }),
    }),
  deleteSecret: (auth: AuthContext, name: string, scope: 'user' | 'workspace' = 'workspace') =>
    callVoid(auth, `/secrets/${encodeURIComponent(name)}?scope=${scope}`, { method: 'DELETE' }),
  // Workspace-owned GitHub App integration (org install → selected repos). Both github.com AND GitHub Enterprise are
  // operator env — the admin only installs + picks repos (no per-workspace App registration). Read/install-start/unlink
  // are settings:read|write (admin). Private-key/token values are never sent down — installation tokens are minted on demand.
  getGithubApp: <T>(auth: AuthContext) => call<T>(auth, '/workspace/github-app'),
  startGithubAppInstall: <T>(auth: AuthContext, body?: unknown) =>
    call<T>(auth, '/workspace/github-app/install/start', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),
  unlinkGithubAppInstallation: <T>(auth: AuthContext, installationId: number) =>
    call<T>(auth, `/workspace/github-app/installations/${encodeURIComponent(installationId)}`, {
      method: 'DELETE',
    }),
  // Repos the workspace App installation can access (CI repo link picker). Only those chosen at install time. settings:read.
  getGithubAppRepos: <T>(auth: AuthContext) => call<T>(auth, '/workspace/github-app/repos'),
  // Workspace-owned Mattermost integration (register → bot notifications). The server URL is operator env (MATTERMOST_HOST),
  // not sent in the body. Read settings:read / register·probe·delete settings:write. The bot token value lives only in the SecretStore.
  getMattermost: <T>(auth: AuthContext) => call<T>(auth, '/workspace/mattermost'),
  setMattermost: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/mattermost', { method: 'PUT', body: JSON.stringify(body) }),
  probeMattermost: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/mattermost/probe', { method: 'POST', body: JSON.stringify(body) }),
  removeMattermost: (auth: AuthContext, name: string) =>
    callVoid(auth, `/workspace/mattermost/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  // Per-harness EXPORT selection (assignment) — body { source: name | null }, null clears it (no export). The referenced
  // name is a registered trace SOURCE (sink-capable kind). harnesses:register (member+) — where to export is the harness owner's call.
  assignHarnessTraceSink: <T>(auth: AuthContext, harnessId: string, body: unknown) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(harnessId)}/trace-sink`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // Workspace trace sources (multiple) — the ONE registration pool for observability platforms (OTel/MLflow/Langfuse/…).
  // A harness uses a source to PULL its trace from and/or to EXPORT judged results to (per-harness use-site choice).
  // Read harnesses:read (viewer+ — for showing the per-harness selection) / register (upsert by name)·delete settings:write.
  // Auth values live only in the SecretStore (only name references pass through).
  listTraceSources: <T>(auth: AuthContext) => call<T>(auth, '/workspace/trace-sources'),
  upsertTraceSource: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/trace-sources', { method: 'PUT', body: JSON.stringify(body) }),
  // Connection test + scope discovery before registering — validate the base URL + resolved secret and list the
  // platform's selectable scopes. settings:write (the probe resolves the workspace secret). A classified failure is still a 200.
  probeTraceSource: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/trace-sources/probe', { method: 'POST', body: JSON.stringify(body) }),
  removeTraceSource: (auth: AuthContext, name: string) =>
    callVoid(auth, `/workspace/trace-sources/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  // Per-harness source selection (assignment) — body { source: name | null }, null clears the selection (no pull).
  // harnesses:register (member+) — the source itself (register/delete) is admin, but which one to pull from is the harness owner's call.
  assignHarnessTraceSource: <T>(auth: AuthContext, harnessId: string, body: unknown) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(harnessId)}/trace-source`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // Observability browser: enumerate a source's recent traces + metrics (the settings traces view + judge-wizard picker).
  // Read harnesses:read (viewer+). scope defaults to the source's configured scope; limit/since are optional.
  listTraceSourceTraces: <T>(
    auth: AuthContext,
    name: string,
    query: { scope?: string; limit?: number; since?: string; until?: string; cursor?: string } = {}
  ) => {
    const qs = new URLSearchParams()
    if (query.scope) qs.set('scope', query.scope)
    if (query.limit !== undefined) qs.set('limit', String(query.limit))
    if (query.since) qs.set('since', query.since)
    if (query.until) qs.set('until', query.until)
    if (query.cursor) qs.set('cursor', query.cursor)
    const suffix = qs.toString()
    return call<T>(
      auth,
      `/workspace/trace-sources/${encodeURIComponent(name)}/traces${suffix ? `?${suffix}` : ''}`
    )
  },
  // Inspect one trace by id — raw span attributes (span-based kinds) + events normalized with the supplied mapping.
  // Powers the wizard's live conversion-authoring loop. Nothing is persisted.
  inspectTrace: <T>(auth: AuthContext, name: string, traceId: string, body: unknown) =>
    call<T>(
      auth,
      `/workspace/trace-sources/${encodeURIComponent(name)}/traces/${encodeURIComponent(traceId)}/inspect`,
      { method: 'POST', body: JSON.stringify(body) }
    ),
  // Workspace image registries (BYO, multiple) — the harness image classification baseline + the everdict image push publish target.
  // Read harnesses:read (viewer+ — for classification badges) / register (upsert by name)·delete settings:write. Secrets pass through as name references only.
  listImageRegistries: <T>(auth: AuthContext) => call<T>(auth, '/workspace/image-registries'),
  upsertImageRegistry: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/image-registries', { method: 'PUT', body: JSON.stringify(body) }),
  // Connection test before registering — GET /v2/ against the host with the configured credential resolved from the
  // SecretStore, classified. settings:write (it resolves the workspace secret). A classified failure is still a 200.
  probeImageRegistry: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/image-registries/probe', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeImageRegistry: (auth: AuthContext, name: string) =>
    callVoid(auth, `/workspace/image-registries/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  // 관리형 이미지 스토어 — everdict가 직접 운영하는 워크스페이스 이미지 네임스페이스(BYO 레지스트리와 별개).
  // 목록/태그는 harnesses:read, 회수(unpublish)는 images:push. 관리형 스토어가 없는 배포에서는 전부 404.
  listWorkspaceImages: <T>(auth: AuthContext) => call<T>(auth, '/workspace/images'),
  listWorkspaceImageTags: <T>(auth: AuthContext, repository: string) =>
    call<T>(auth, `/workspace/images/${encodeURIComponent(repository)}/tags`),
  // 태그/다이제스트 하나의 상세 — 핀 다이제스트 + (best-effort) OCI config 유래 빌드 히스토리·런타임 구성·크기.
  inspectWorkspaceImage: <T>(auth: AuthContext, repository: string, reference: string) =>
    call<T>(
      auth,
      `/workspace/images/manifest?repository=${encodeURIComponent(repository)}&reference=${encodeURIComponent(reference)}`
    ),
  removeWorkspaceImage: <T>(auth: AuthContext, repository: string) =>
    call<T>(auth, `/workspace/images/${encodeURIComponent(repository)}`, { method: 'DELETE' }),
  // Workspace environment-image adoption (import) — the inventory of adopted environments + pull-usability verify.
  // Read = capabilities:read (viewer+); adopt/unadopt/verify = settings:write (admin, workspace-level config).
  listAdoptedEnvironments: <T>(auth: AuthContext) =>
    call<T>(auth, '/workspace/adopted-environments'),
  adoptEnvironment: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/adopted-environments', { method: 'PUT', body: JSON.stringify(body) }),
  verifyAdoptedEnvironment: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/adopted-environments/verify', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  unadoptEnvironment: (auth: AuthContext, source: string, id: string) =>
    callVoid(
      auth,
      `/workspace/adopted-environments/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    ),
  // CI repo link (repo ↔ harness slot = GitHub Actions OIDC trust). Read=harnesses:read (viewer+), create/delete=settings:write (admin).
  // A link's existence grants that repo's keyless CI trust. All three routes return the full current link set ({links}) (not 204).
  listCiLinks: <T>(auth: AuthContext) => call<T>(auth, '/workspace/ci/links'),
  upsertCiLink: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/ci/links', { method: 'PUT', body: JSON.stringify(body) }),
  // repository ("owner/name") contains a slash, so it's taken as a query instead of a path. host unspecified = github.com link.
  deleteCiLink: <T>(auth: AuthContext, repository: string, host?: string) =>
    call<T>(
      auth,
      `/workspace/ci/links?repository=${encodeURIComponent(repository)}${host ? `&host=${encodeURIComponent(host)}` : ''}`,
      { method: 'DELETE' }
    ),
  // setup-PR — synthesize workflow YAML from the link and branch+commit+PR to the target repo (workspace GitHub App token). harnesses:read.
  setupCiLinkPr: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/ci/links/setup-pr', { method: 'POST', body: JSON.stringify(body) }),
  // Self-hosted runners (personally owned device pairing). List = only my (subject) runner metadata (no token).
  // pair returns a plaintext token (rnr_…) once only (stored as a hash), revoke returns 204 (callVoid).
  listRunners: <T>(auth: AuthContext) => call<T>(auth, '/runners'),
  pairRunner: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/runners', { method: 'POST', body: JSON.stringify(body) }),
  revokeRunner: (auth: AuthContext, id: string) =>
    callVoid(auth, `/runners/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Workspace-shared runners (team resource, owner=ws:<workspace>). An admin registers (settings:write) → any member can target self:ws:<id>.
  // owned = team-owned runners only (the roster [GET /workspace/runners] includes personal runners), pair returns the plaintext token once, revoke 204.
  listWorkspaceOwnedRunners: <T>(auth: AuthContext) => call<T>(auth, '/workspace/runners/owned'),
  // Workspace runner roster (members:read) — runner metadata paired to this workspace. For deciding whether to expose the self:ws pool.
  listWorkspaceRunners: <T>(auth: AuthContext) => call<T>(auth, '/workspace/runners'),
  pairWorkspaceRunner: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/runners', { method: 'POST', body: JSON.stringify(body) }),
  revokeWorkspaceRunner: (auth: AuthContext, id: string) =>
    callVoid(auth, `/workspace/runners/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // GitHub Actions runner self-registration — generate an install script that stands up a GitHub runner + an Everdict workspace-shared runner together on the build server.
  githubInstallWorkspaceRunner: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/runners/github-install', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // API keys (ak_… for agents/MCP). On issue the plaintext is returned once only, the list shows only the prefix (no plaintext/hash), revoke (204).
  listKeys: <T>(auth: AuthContext) => call<T>(auth, '/keys'),
  createKey: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/keys', { method: 'POST', body: JSON.stringify(body) }),
  revokeKey: (auth: AuthContext, id: string) =>
    callVoid(auth, `/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Workspace member management (read=viewer+, role change/remove=admin) + invites (issue/list/revoke=admin, accept=auth only).
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
  // Unauthenticated preview (server validates only the token) — shows the workspace name/thumbnail on the link landing. auth is sent if present but the server ignores it.
  previewInvite: <T>(auth: AuthContext, token: string) =>
    call<T>(auth, `/invites/preview?token=${encodeURIComponent(token)}`),
  // Edit my profile (name/username/avatar) — email isn't accepted since it's SSO (read-only). PATCH /me/profile → updated profile.
  updateProfile: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/me/profile', { method: 'PATCH', body: JSON.stringify(body) }),
  // Leave this workspace (self-serve). 409 if I'm the last admin. 204 (no body) → callVoid.
  leaveWorkspace: (auth: AuthContext) => callVoid(auth, '/members/me', { method: 'DELETE' }),
}
