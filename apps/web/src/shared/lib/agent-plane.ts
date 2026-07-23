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
    call<T>(auth, '/agent/skills/try', { method: 'POST', body: JSON.stringify({ skill, message }) }),
  listSessions: <T>(auth: AuthContext) => call<T>(auth, '/agent/sessions'),
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
  listMessages: <T>(auth: AuthContext, id: string, since?: number) =>
    call<T>(
      auth,
      `/agent/sessions/${encodeURIComponent(id)}/messages${since !== undefined ? `?since=${since}` : ''}`
    ),
  chat: <T>(auth: AuthContext, id: string, body: unknown) =>
    call<T>(auth, `/agent/sessions/${encodeURIComponent(id)}/chat`, {
      method: 'POST',
      body: JSON.stringify(body),
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
