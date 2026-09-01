import 'server-only'

import { headers } from 'next/headers'
import { cache } from 'react'

import { keycloakConfigured } from '@/shared/config/env'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

import { getAccessToken } from './access-token'
import { getActiveWorkspace } from './active-workspace'
import { ACTIVE_WORKSPACE_HEADER } from './workspace-scope'

// The workspaces I belong to (= GET /me's workspaces, for the sidebar switcher).
export interface WebWorkspace {
  id: string
  name: string
  role: string
}

// My profile (name/username/avatar) — control-plane-owned mutable info (GET /me.profile). email isn't here (SSO claim).
export interface WebProfile {
  name?: string
  username?: string
  avatarUrl?: string
}

// The Principal the control plane returns (= GET /me). The web doesn't interpret this value, it trusts it as-is.
export interface WebPrincipal {
  subject: string
  workspace: string // current active workspace id
  roles: string[]
  // 이 워크스페이스에서 내가 속한 팀들. 역할과 함께 제어 평면이 요청마다 채워 주는 인가 입력이다 —
  // 남의 팀 자산을 쓰는 요청은 제어 평면이 403 으로 막고, 웹은 그 버튼을 미리 감추는 데만 쓴다(can.ts).
  teams?: string[]
  via: 'oidc' | 'api-key'
  email?: string // OIDC email/preferred_username claim (display-only·read-only)
  workspaces?: WebWorkspace[] // list of workspaces I belong to (when a membership store exists)
  profile?: WebProfile // mutable display info (name/username/avatar)
  config?: WebInstanceConfig // read-only instance config for UX gating (control plane still enforces)
}

// Read-only instance config the control plane surfaces on GET /me — display/UX-gating only, never an authz input.
export interface WebInstanceConfig {
  allowMemberPublicPublish?: boolean // a member (not only an admin) may publish a capability to the public catalog
  fileExecution?: boolean // this deployment can run a workspace file (an execution driver is composed) — gates the viewer's Run
}

// The control plane auth context for the current request. Logged-in user → Keycloak Bearer, dev (unset) → x-everdict-tenant=default.
// The authority for the active workspace is the URL's first segment — middleware injects it as the x-everdict-active-workspace header (Linear-style /{workspace}/...).
// On paths middleware didn't hit (root etc.) fall back to the most-recent cookie. If the enclosed (x-everdict-workspace) workspace is a non-member, the control plane falls back to the default.
// Memoized per REQUEST for the same reason `currentPrincipal` below is, and it is the half that pays even on
// pages that never ask who I am: most callers reach for `authContext()` directly to get a context for their
// own reads, and each call re-read the headers and decrypted the session JWT (twice, on the cookie-prefix
// miss). Nothing here can change inside one render.
export const authContext = cache(async (): Promise<AuthContext> => {
  const fromHeader = (await headers()).get(ACTIVE_WORKSPACE_HEADER) ?? undefined
  const workspace = fromHeader ?? (await getActiveWorkspace())
  const ws = workspace ? { workspace } : {}
  if (!keycloakConfigured) return { devTenant: 'default', ...ws }
  const token = await getAccessToken() // server-only — don't expose the token to the client session (BFF)
  return token ? { bearer: token, ...ws } : { devTenant: 'default', ...ws }
})

// The current Principal + auth context. The authority for workspace/roles is the control plane's GET /me (the web doesn't interpret the token).
// If it fails (control plane down etc.) principal=null (the caller handles it gracefully).
//
// ── ONE `/me` PER REQUEST, NOT ONE PER CALLER ────────────────────────────────────────────────────────
//
// 92 call sites, and a single navigation reaches several of them: the workspace layout asks, the page asks,
// and the widgets and features it renders ask again. Every control-plane call is `cache: 'no-store'`, so
// each of those was a real round trip — and `GET /me` is not cheap on the other end either (the principal,
// the subject's workspaces, and the profile). A screen paid two to five `/me` calls before its own data
// started.
//
// React's `cache` is request-scoped memoization, which is exactly the shape of the question: WITHIN one
// render, who I am cannot change, and ACROSS requests nothing is retained. It is not a cache in the
// stale-data sense and does not weaken the `no-store` policy — the second caller in the same render gets the
// first caller's answer instead of asking again.
//
// Memoized here rather than on `controlPlane.me` so `authContext()` (headers + token decode) is deduped with
// it: the two are one question, and splitting them would leave the cheaper half running N times for nothing.
export const currentPrincipal = cache(
  async (): Promise<{
    principal: WebPrincipal | null
    ctx: AuthContext
  }> => {
    const ctx = await authContext()
    try {
      return { principal: await controlPlane.me<WebPrincipal>(ctx), ctx }
    } catch {
      return { principal: null, ctx }
    }
  }
)
