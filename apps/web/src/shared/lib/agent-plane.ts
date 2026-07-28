import 'server-only'

import { env } from '@/shared/config/env'
import type { AuthContext } from '@/shared/lib/control-plane'

// Agent server (@everdict/agent) HTTP client — server-only. Mirrors the control-plane BFF: forward the logged-in
// user's Keycloak bearer (or the dev tenant) plus the active workspace, so the agent server acts on the caller's
// behalf. The browser never sees the token; it calls the same-origin /api/agent/* proxy routes.

function authHeaders(auth: AuthContext): Record<string, string> {
  const headers: Record<string, string> =
    'bearer' in auth
      ? { authorization: `Bearer ${auth.bearer}` }
      : { 'x-everdict-tenant': auth.devTenant }
  if (auth.workspace) headers['x-everdict-workspace'] = auth.workspace
  return headers
}

async function call<T>(auth: AuthContext, path: string, init?: RequestInit): Promise<T> {
  const headers = authHeaders(auth)
  if (init?.body != null) headers['content-type'] = 'application/json'
  const res = await fetch(`${env.AGENT_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`agent ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const agentPlane = {
  // Skill test-drive — run a stateless agent turn with just this (possibly unsaved) skill + read-only tools, return the transcript.
  trySkill: <T>(auth: AuthContext, skill: unknown, message: string) =>
    call<T>(auth, '/agent/skills/try', {
      method: 'POST',
      body: JSON.stringify({ skill, message }),
    }),
  // Code-tool verification — check (parse-only) or run (execute an example input) a draft spec or a published
  // capability ref, under the agent's own execution contract + sandbox gate. Stateless.
  tryCodeTool: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/agent/code-tools/try', { method: 'POST', body: JSON.stringify(body) }),
  listSessions: <T>(auth: AuthContext) => call<T>(auth, '/agent/sessions'),
  // A View's pinned analysis artifacts (analysis-studio V3) — the agent service re-verifies view visibility
  // with the forwarded bearer, so this stays a pure courier.
  listViewArtifacts: <T>(auth: AuthContext, viewId: string) =>
    call<T>(auth, `/agent/views/${encodeURIComponent(viewId)}/artifacts`),
  // A conversation's emitted analysis artifacts, oldest first (owner-scoped by the agent service).
  listSessionArtifacts: <T>(auth: AuthContext, sessionId: string) =>
    call<T>(auth, `/agent/sessions/${encodeURIComponent(sessionId)}/artifacts`),
  // Pin/unpin a conversation artifact onto a View (creator-only; view visibility re-verified by the agent service).
  pinArtifact: <T>(auth: AuthContext, artifactId: string, viewId: string) =>
    call<T>(auth, `/agent/artifacts/${encodeURIComponent(artifactId)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ viewId }),
    }),
  unpinArtifact: (auth: AuthContext, artifactId: string) =>
    call<void>(auth, `/agent/artifacts/${encodeURIComponent(artifactId)}/pin`, {
      method: 'DELETE',
    }),
  // Per-view artifact rollup for the views the caller already holds (count + newest report time).
  viewArtifactsSummary: <T>(auth: AuthContext, viewIds: string[]) =>
    call<T>(auth, `/agent/views/artifacts-summary?ids=${encodeURIComponent(viewIds.join(','))}`),
  createSession: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/agent/sessions', { method: 'POST', body: JSON.stringify(body) }),
  getSession: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/agent/sessions/${encodeURIComponent(id)}`),
  deleteSession: (auth: AuthContext, id: string) =>
    call<void>(auth, `/agent/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  renameSession: <T>(auth: AuthContext, id: string, title: string) =>
    call<T>(auth, `/agent/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  // Partial update: rename (title) and/or pin the conversation's model (model: id, or null to clear the override).
  updateSession: <T>(
    auth: AuthContext,
    id: string,
    patch: { title?: string; model?: string | null; permissionMode?: string | null }
  ) =>
    call<T>(auth, `/agent/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  // Fleet view (docs/architecture/agent-automation.md A5) — every agent RUN in the workspace (trigger
  // activations, teammates, discussion turns), newest first; stopRun aborts a live headless run.
  listRuns: <T>(auth: AuthContext, limit?: number) =>
    call<T>(auth, `/agent/runs${limit !== undefined ? `?limit=${limit}` : ''}`),
  stopRun: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/agent/runs/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Teammates (docs/architecture/agent-teams.md) — the caller's live autonomous agents. List the roster, spawn one
  // (name + standing task + watched event kinds), or stop one (unregister + revoke its token; the transcript is kept).
  listTeammates: <T>(auth: AuthContext) => call<T>(auth, '/agent/teammates'),
  spawnTeammate: <T>(auth: AuthContext, body: unknown) =>
    call<T>(auth, '/agent/teammates', { method: 'POST', body: JSON.stringify(body) }),
  stopTeammate: (auth: AuthContext, id: string) =>
    call<void>(auth, `/agent/teammates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listMessages: <T>(auth: AuthContext, id: string, since?: number) =>
    call<T>(
      auth,
      `/agent/sessions/${encodeURIComponent(id)}/messages${since !== undefined ? `?since=${since}` : ''}`
    ),
  // 백그라운드(논의) 턴이 대기 중인 쓰기도구 승인 목록 — 워치 모드 패널이 폴링해 승인 프롬프트를 띄운다.
  listPending: <T>(auth: AuthContext, id: string) =>
    call<T>(auth, `/agent/sessions/${encodeURIComponent(id)}/pending`),
  chat: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/agent/sessions/${encodeURIComponent(id)}/chat`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // HITL: resolve a write-tool approval the streaming turn is awaiting (allow/deny).
  respondPermission: <T>(
    auth: AuthContext,
    id: string,
    requestId: string,
    decision: 'allow' | 'deny'
  ) =>
    call<T>(auth, `/agent/sessions/${encodeURIComponent(id)}/permission`, {
      method: 'POST',
      body: JSON.stringify({ requestId, decision }),
    }),
  // Raw (unbuffered) chat — forwards the caller's Accept so the BFF can stream an SSE turn straight through.
  chatRaw: (auth: AuthContext, id: string, body: unknown, accept: string): Promise<Response> => {
    const headers = authHeaders(auth)
    headers['content-type'] = 'application/json'
    if (accept) headers.accept = accept
    return fetch(
      `${env.AGENT_URL.replace(/\/$/, '')}/agent/sessions/${encodeURIComponent(id)}/chat`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-store',
      }
    )
  },
}
