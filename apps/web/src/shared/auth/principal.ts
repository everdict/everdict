import 'server-only'

import { headers } from 'next/headers'

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
  via: 'oidc' | 'api-key'
  email?: string // OIDC email/preferred_username claim (display-only·read-only)
  workspaces?: WebWorkspace[] // list of workspaces I belong to (when a membership store exists)
  profile?: WebProfile // mutable display info (name/username/avatar)
}

// The control plane auth context for the current request. Logged-in user → Keycloak Bearer, dev (unset) → x-everdict-tenant=default.
// The authority for the active workspace is the URL's first segment — middleware injects it as the x-everdict-active-workspace header (Linear-style /{workspace}/...).
// On paths middleware didn't hit (root etc.) fall back to the most-recent cookie. If the enclosed (x-everdict-workspace) workspace is a non-member, the control plane falls back to the default.
export async function authContext(): Promise<AuthContext> {
  const fromHeader = (await headers()).get(ACTIVE_WORKSPACE_HEADER) ?? undefined
  const workspace = fromHeader ?? (await getActiveWorkspace())
  const ws = workspace ? { workspace } : {}
  if (!keycloakConfigured) return { devTenant: 'default', ...ws }
  const token = await getAccessToken() // server-only — don't expose the token to the client session (BFF)
  return token ? { bearer: token, ...ws } : { devTenant: 'default', ...ws }
}

// The current Principal + auth context. The authority for workspace/roles is the control plane's GET /me (the web doesn't interpret the token).
// If it fails (control plane down etc.) principal=null (the caller handles it gracefully).
export async function currentPrincipal(): Promise<{
  principal: WebPrincipal | null
  ctx: AuthContext
}> {
  const ctx = await authContext()
  try {
    return { principal: await controlPlane.me<WebPrincipal>(ctx), ctx }
  } catch {
    return { principal: null, ctx }
  }
}
