import NextAuth from 'next-auth'
import type { JWT } from 'next-auth/jwt'
import Keycloak from 'next-auth/providers/keycloak'

import { env, keycloakConfigured } from '@/shared/config/env'

// Keycloak(OIDC)로 사람(테넌트 유저)을 인증하고, 발급된 액세스 토큰을 컨트롤플레인에 전달한다(BFF).
// 인증/인가의 권위는 컨트롤플레인(@assay/api + @assay/auth)이 가진다 — 웹은 토큰 운반자(courier)일 뿐,
// 워크스페이스/역할을 토큰에서 직접 해석하지 않는다(그건 GET /me 가 한다).
// 하드닝(BFF): 액세스/리프레시 토큰은 서버 전용 httpOnly 암호화 쿠키(JWT)에만 두고, 클라이언트 세션에는
// 절대 싣지 않는다 — 서버에서 getAccessToken()(getToken)으로만 읽는다. session 에는 비민감 플래그만.
// (에이전트/MCP/CI 는 API 키로 컨트롤플레인에 직접 인증 — 상보적.)
declare module 'next-auth' {
  interface Session {
    error?: 'RefreshFailed'
  }
}
declare module 'next-auth/jwt' {
  interface JWT {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number // epoch 초
    error?: 'RefreshFailed'
  }
}

// 리프레시 토큰으로 액세스 토큰 갱신(Keycloak 토큰 엔드포인트). 실패 시 error 를 실어 보낸다.
async function refresh(token: JWT): Promise<JWT> {
  if (!token.refreshToken) return { ...token, error: 'RefreshFailed' }
  try {
    const res = await fetch(`${env.KEYCLOAK_ISSUER}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.KEYCLOAK_CLIENT_ID ?? '',
        client_secret: env.KEYCLOAK_CLIENT_SECRET ?? '',
        refresh_token: token.refreshToken,
      }),
    })
    const data = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!res.ok || !data.access_token) return { ...token, error: 'RefreshFailed' }
    return {
      ...token,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? token.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 300),
      error: undefined,
    }
  } catch {
    return { ...token, error: 'RefreshFailed' }
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // 자체호스팅(self-hosted) — Vercel 이 아니므로 호스트를 신뢰한다. 없으면 `next start` 가
  // 모든 /api/auth/* 에서 UntrustedHost(500) 를 던진다(AUTH_TRUST_HOST 환경변수와 동등).
  trustHost: true,
  // Keycloak 미설정(dev)에선 실제 로그인이 없으므로 더미 시크릿으로 /api/auth MissingSecret(500) 방지.
  // 설정됐는데 AUTH_SECRET 이 없으면 secret 미지정 → 일부러 실패(안전한 시크릿을 강제).
  ...(keycloakConfigured ? {} : { secret: env.AUTH_SECRET ?? 'assay-dev-insecure-secret' }),
  providers: keycloakConfigured
    ? [
        Keycloak({
          issuer: env.KEYCLOAK_ISSUER,
          clientId: env.KEYCLOAK_CLIENT_ID,
          clientSecret: env.KEYCLOAK_CLIENT_SECRET,
        }),
      ]
    : [],
  callbacks: {
    async jwt({ token, account }) {
      // 첫 로그인: 액세스/리프레시 토큰 묶음 저장.
      if (account) {
        token.accessToken = account.access_token
        token.refreshToken = account.refresh_token
        token.expiresAt = account.expires_at
        return token
      }
      // 아직 유효(만료 60초 전까지)하면 그대로, 아니면 갱신.
      if (token.expiresAt && Date.now() / 1000 < token.expiresAt - 60) return token
      return refresh(token)
    },
    session({ session, token }) {
      // 액세스 토큰은 절대 세션(=클라이언트 노출)에 싣지 않는다. 비민감 상태 플래그만 노출.
      session.error = token.error
      return session
    },
  },
})
