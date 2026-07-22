import { NextResponse, type NextRequest } from 'next/server'

import { auth } from '@/shared/auth/auth'
import {
  ACTIVE_WORKSPACE_COOKIE,
  ACTIVE_WORKSPACE_HEADER,
  ACTIVE_WORKSPACE_MAX_AGE,
  workspaceSlugFromPath,
} from '@/shared/auth/workspace-scope'
import { keycloakConfigured } from '@/shared/config/env'

// Inject the URL's first segment (= active workspace slug, Linear-style /{workspace}/...) as a request header and
// sync the most-recent cookie. authContext reads this header and forwards it as the control-plane scope (x-everdict-workspace).
// Reserved / non-slug first segments (root·onboarding·invite·new-workspace, etc.) have no workspace context, so pass through as-is.
function injectWorkspace(req: NextRequest): NextResponse {
  const slug = workspaceSlugFromPath(req.nextUrl.pathname)
  if (!slug) return NextResponse.next()
  const headers = new Headers(req.headers)
  headers.set(ACTIVE_WORKSPACE_HEADER, slug)
  // Infra-panel iframe marker — the panel loads pages with ?embed=1 (Sec-Fetch-Dest is only sent on
  // trustworthy origins, so plain-HTTP dev needs the explicit param). Promoted to a request header the
  // [workspace] layout reads to render chrome-less; in-iframe soft navigation keeps that layout instance.
  if (req.nextUrl.searchParams.get('embed') === '1') headers.set('x-everdict-embed', '1')
  const res = NextResponse.next({ request: { headers } })
  // Same attributes as active-workspace.ts setActiveWorkspace — so action writes and middleware writes don't conflict.
  res.cookies.set(ACTIVE_WORKSPACE_COOKIE, slug, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ACTIVE_WORKSPACE_MAX_AGE,
  })
  return res
}

// Redirect to login, carrying the original path as callbackUrl so we return to that spot after login.
// (Block the loop where a stale callbackUrl=`/` in the cookie bounces back again, using an explicit callbackUrl.)
function signinRedirect(req: NextRequest): NextResponse {
  const url = new URL('/api/auth/signin', req.nextUrl.origin)
  url.searchParams.set('callbackUrl', req.nextUrl.pathname)
  return NextResponse.redirect(url)
}

// When Keycloak is configured: refresh-failed sessions·unauthenticated workspace paths → login. Otherwise inject the workspace header.
const protect = auth((req) => {
  // Token refresh failure: the session remains but the token is dead → the control plane returns 401, so principal=null and
  // the layout bounces again into an infinite loop. Break it by sending straight to re-login on every path.
  if (req.auth?.error === 'RefreshFailed') return signinRedirect(req)
  if (!req.auth && workspaceSlugFromPath(req.nextUrl.pathname)) return signinRedirect(req)
  return injectWorkspace(req)
})

// Unconfigured (dev): don't use the NextAuth wrapper (so it works without AUTH_SECRET) and only inject the header.
export default keycloakConfigured ? protect : (req: NextRequest) => injectWorkspace(req)

// Runs across all of /{workspace}/* but excludes api·_next·static files·root (/). Workspace validation is handled by [workspace]/layout.
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)'],
}
