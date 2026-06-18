import { NextResponse } from 'next/server'

import { auth } from '@/shared/auth/auth'
import { keycloakConfigured } from '@/shared/config/env'

// Keycloak 설정 시: /dashboard 를 보호(미인증 → 로그인). 미설정(dev): NextAuth 래퍼를 쓰지 않고 통과
// (그래야 AUTH_SECRET 없이도 동작). 보호 로직은 설정됐을 때만 활성화된다.
const protect = auth((req) => {
  if (!req.auth && req.nextUrl.pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/api/auth/signin', req.nextUrl.origin))
  }
  return NextResponse.next()
})

export default keycloakConfigured ? protect : () => NextResponse.next()

export const config = { matcher: ['/dashboard/:path*'] }
