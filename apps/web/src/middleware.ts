import { NextResponse, type NextRequest } from 'next/server'

import { auth } from '@/shared/auth/auth'
import {
  ACTIVE_WORKSPACE_COOKIE,
  ACTIVE_WORKSPACE_HEADER,
  ACTIVE_WORKSPACE_MAX_AGE,
  workspaceSlugFromPath,
} from '@/shared/auth/workspace-scope'
import { keycloakConfigured } from '@/shared/config/env'

// URL 첫 세그먼트(= 활성 워크스페이스 slug, Linear 식 /{workspace}/...)를 요청 헤더로 주입하고
// most-recent 쿠키를 동기화한다. authContext 가 이 헤더를 읽어 컨트롤플레인 스코프(x-assay-workspace)로 전달한다.
// 예약어/비-slug 첫 세그먼트(루트·onboarding·invite·new-workspace 등)는 워크스페이스 컨텍스트가 없으니 그대로 통과.
function injectWorkspace(req: NextRequest): NextResponse {
  const slug = workspaceSlugFromPath(req.nextUrl.pathname)
  if (!slug) return NextResponse.next()
  const headers = new Headers(req.headers)
  headers.set(ACTIVE_WORKSPACE_HEADER, slug)
  const res = NextResponse.next({ request: { headers } })
  // active-workspace.ts setActiveWorkspace 와 동일 속성 — 액션 쓰기와 미들웨어 쓰기가 충돌하지 않게.
  res.cookies.set(ACTIVE_WORKSPACE_COOKIE, slug, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ACTIVE_WORKSPACE_MAX_AGE,
  })
  return res
}

// Keycloak 설정 시: 미인증 + 워크스페이스 경로 → 로그인. 그 외엔 워크스페이스 헤더 주입.
const protect = auth((req) => {
  if (!req.auth && workspaceSlugFromPath(req.nextUrl.pathname)) {
    return NextResponse.redirect(new URL('/api/auth/signin', req.nextUrl.origin))
  }
  return injectWorkspace(req)
})

// 미설정(dev): NextAuth 래퍼를 쓰지 않고(그래야 AUTH_SECRET 없이 동작) 헤더 주입만 한다.
export default keycloakConfigured ? protect : (req: NextRequest) => injectWorkspace(req)

// /{workspace}/* 전체에서 돌되 api·_next·정적파일·루트(/)는 제외. 워크스페이스 검증은 [workspace]/layout 이 담당.
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)'],
}
