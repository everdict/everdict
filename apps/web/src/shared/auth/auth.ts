import NextAuth from 'next-auth'
import Keycloak from 'next-auth/providers/keycloak'

import { env, keycloakConfigured } from '@/shared/config/env'

// Keycloak(OIDC)로 사람(테넌트 유저) 인증. tenant 는 토큰 클레임(기본 "tenant")에서 파생.
// (에이전트/MCP/CI 는 별도 API 키로 컨트롤플레인에 직접 인증 — 상보적.)
declare module 'next-auth' {
  interface Session {
    tenant?: string
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
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
    // 첫 로그인 시 프로필 클레임에서 tenant 를 JWT 에 싣는다.
    jwt({ token, profile }) {
      if (profile) {
        const claim = (profile as Record<string, unknown>)[env.TENANT_CLAIM]
        token.tenant = typeof claim === 'string' ? claim : token.tenant
      }
      return token
    },
    session({ session, token }) {
      session.tenant = typeof token.tenant === 'string' ? token.tenant : undefined
      return session
    },
  },
})
