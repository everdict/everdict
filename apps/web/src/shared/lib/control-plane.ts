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

// For 204 (No Content) responses only — mutations with no body where res.json() must not be called (e.g. secret set/delete).
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
  // Workspace membership (self-serve): my workspace list + create (creator is admin).
  listWorkspaces: <T>(auth: AuthContext) => call<T>(auth, '/workspaces'),
  createWorkspace: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspaces', { method: 'POST', body: JSON.stringify(body) }),
  // Active workspace record (name/logo/owner) read·update·delete. Singular /workspace.
  getWorkspace: <T>(auth: AuthContext) => call<T>(auth, '/workspace'),
  updateWorkspace: <T>(auth: AuthContext, patch: unknown) =>
    call<T>(auth, '/workspace', { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteWorkspace: (auth: AuthContext) => callVoid(auth, '/workspace', { method: 'DELETE' }),
  // When scorecardId is given, that scorecard's per-case child runs (drilldown); otherwise the standalone activity list (children hidden).
  listRuns: <T>(auth: AuthContext, opts?: { scorecardId?: string }) =>
    call<T>(
      auth,
      opts?.scorecardId ? `/runs?scorecardId=${encodeURIComponent(opts.scorecardId)}` : '/runs'
    ),
  getRun: <T>(auth: AuthContext, id: string) => call<T>(auth, `/runs/${encodeURIComponent(id)}`),
  // Live-progress log snapshot (the LiveLogs widget polls; found=false = nothing to tail yet).
  getRunLogs: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/logs`),
  // One-shot exec inside a run's live sandbox (SandboxTerminal). Creator-or-admin, enforced by the control plane.
  execInRun: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/exec`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Live screen frame (LiveScreen — os-use desktop). supported=false for other env kinds.
  getRunScreen: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/runs/${encodeURIComponent(id)}/screen`),
  // Work queue snapshot — per-runtime-lane running / waiting (FIFO) / next scheduled fire.
  getQueue: <T>(auth: AuthContext) => call<T>(auth, '/queue'),
  // Metered billing usage (LLM cost for orchestration + verdict; own-pays runs excluded) — meter-only, never blocks.
  getUsage: <T>(auth: AuthContext) => call<T>(auth, '/usage'),
  submitRun: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/runs', { method: 'POST', body: JSON.stringify(body) }),
  listHarnesses: <T>(auth: AuthContext) => call<T>(auth, '/harnesses'),
  // GET /harnesses/:id — a harness's instance version tag list.
  getHarness: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(id)}`),
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
  // GET /harnesses/:id/:version — resolved HarnessSpec (template + pins). For detail/diagramming.
  getHarnessSpec: <T>(auth: AuthContext, id: string, version: string) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(id)}/${encodeURIComponent(version)}`),
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
  listDatasets: <T>(auth: AuthContext) => call<T>(auth, '/datasets'),
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
  // Saved scorecard-analysis View — a named AnalysisConfig (opaque), private|shared. Re-run live against current data on open.
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
  getWorkspaceSettings: <T>(auth: AuthContext) => call<T>(auth, '/workspace/settings'),
  setWorkspaceSettings: <T>(auth: AuthContext, patch: unknown) =>
    call<T>(auth, '/workspace/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  // Workspace secrets (model/provider keys + cluster credentials) — values are never returned (list = name + updatedAt).
  // At-rest encryption is the control plane's SecretStore. set/delete return 204 (no body) → callVoid.
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
  // Workspace-owned GitHub App integration (org install → selected repos). Read/install-start/register/unlink are all settings:read|write (admin).
  // Private-key/token values are never sent down — an installation issues tokens on demand, so only metadata (no secrets).
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
  // host is a URL (contains slashes/colons), so pass it as a query instead of a path.
  removeGithubAppRegistration: <T>(auth: AuthContext, host: string) =>
    call<T>(auth, `/workspace/github-app/registrations?host=${encodeURIComponent(host)}`, {
      method: 'DELETE',
    }),
  unlinkGithubAppInstallation: <T>(auth: AuthContext, installationId: number) =>
    call<T>(auth, `/workspace/github-app/installations/${encodeURIComponent(installationId)}`, {
      method: 'DELETE',
    }),
  // Repos the workspace App installation can access (CI repo link picker). Only those chosen at install time. settings:read.
  getGithubAppRepos: <T>(auth: AuthContext) => call<T>(auth, '/workspace/github-app/repos'),
  // Workspace-owned Mattermost integration (register → bot notifications). Read settings:read / register·delete settings:write. The bot token value lives only in the SecretStore.
  getMattermost: <T>(auth: AuthContext) => call<T>(auth, '/workspace/mattermost'),
  setMattermost: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/mattermost', { method: 'PUT', body: JSON.stringify(body) }),
  removeMattermost: (auth: AuthContext) =>
    callVoid(auth, '/workspace/mattermost', { method: 'DELETE' }),
  // Workspace trace sinks (multiple) — export judged scorecard detail results to the team's observability platform (MLflow etc.).
  // Read harnesses:read (viewer+ — for showing the per-harness selection) / register (upsert by name)·delete settings:write.
  // Auth values live only in the SecretStore (only name references pass through).
  listTraceSinks: <T>(auth: AuthContext) => call<T>(auth, '/workspace/trace-sinks'),
  upsertTraceSink: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/trace-sinks', { method: 'PUT', body: JSON.stringify(body) }),
  removeTraceSink: (auth: AuthContext, name: string) =>
    callVoid(auth, `/workspace/trace-sinks/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  // Per-harness sink selection (assignment) — body { sink: name | null }, null clears the selection (no export).
  // harnesses:register (member+) — the sink itself (register/delete) is admin, but where to export is the harness owner's call.
  assignHarnessTraceSink: <T>(auth: AuthContext, harnessId: string, body: unknown) =>
    call<T>(auth, `/harnesses/${encodeURIComponent(harnessId)}/trace-sink`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // Workspace image registries (BYO, multiple) — the harness image classification baseline + the everdict image push publish target.
  // Read harnesses:read (viewer+ — for classification badges) / register (upsert by name)·delete settings:write. Secrets pass through as name references only.
  listImageRegistries: <T>(auth: AuthContext) => call<T>(auth, '/workspace/image-registries'),
  upsertImageRegistry: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/workspace/image-registries', { method: 'PUT', body: JSON.stringify(body) }),
  removeImageRegistry: (auth: AuthContext, name: string) =>
    callVoid(auth, `/workspace/image-registries/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
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
