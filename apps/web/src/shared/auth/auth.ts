import NextAuth from 'next-auth'
import type { JWT } from 'next-auth/jwt'
import Keycloak from 'next-auth/providers/keycloak'

import { env, keycloakConfigured } from '@/shared/config/env'

// Authenticate humans (tenant users) via Keycloak (OIDC) and forward the issued access token to the control plane (BFF).
// The authority for authentication/authz is the control plane (@everdict/api + @everdict/auth) — the web is just a token courier,
// it doesn't interpret workspace/roles from the token directly (GET /me does that).
// Hardening (BFF): the access/refresh tokens live only in a server-only httpOnly encrypted cookie (JWT) and are
// never carried on the client session — read on the server via getAccessToken() (getToken) only. The session holds only non-sensitive flags.
// (Agents/MCP/CI authenticate to the control plane directly with API keys — complementary.)
declare module 'next-auth' {
  interface Session {
    error?: 'RefreshFailed'
  }
}
declare module 'next-auth/jwt' {
  interface JWT {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number // epoch seconds
    error?: 'RefreshFailed'
  }
}

// Refresh the access token with the refresh token (Keycloak token endpoint). On failure, attach error.
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
  // Self-hosted — not Vercel, so trust the host. Without it, `next start` throws
  // UntrustedHost(500) on all /api/auth/* (equivalent to the AUTH_TRUST_HOST env var).
  trustHost: true,
  // When Keycloak is unset (dev) there's no real login, so a dummy secret prevents /api/auth MissingSecret(500).
  // If it's configured but AUTH_SECRET is missing, secret stays unset → deliberately fail (to force a secure secret).
  ...(keycloakConfigured ? {} : { secret: env.AUTH_SECRET ?? 'everdict-dev-insecure-secret' }),
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
    // Clean up the post-login return URL — don't send to a non-page like favicon.ico (static assets·extensions·_next·api) or an external origin,
    // route those to home (/) instead. (Blocks the issue where a dead callbackUrl=/favicon.ico bounced you out and you couldn't enter the app.)
    redirect({ url, baseUrl }) {
      let target: URL
      try {
        target = url.startsWith('/') ? new URL(url, baseUrl) : new URL(url)
      } catch {
        return baseUrl
      }
      if (target.origin !== baseUrl) return baseUrl
      const p = target.pathname
      const isNonPage =
        p === '/favicon.ico' ||
        /\.[a-z0-9]+$/i.test(p) ||
        p.startsWith('/_next') ||
        p.startsWith('/api')
      return isNonPage ? baseUrl : `${baseUrl}${target.pathname}${target.search}`
    },
    async jwt({ token, account }) {
      // First login: store the access/refresh token bundle.
      if (account) {
        token.accessToken = account.access_token
        token.refreshToken = account.refresh_token
        token.expiresAt = account.expires_at
        return token
      }
      // If still valid (until 60 seconds before expiry) keep it, otherwise refresh.
      if (token.expiresAt && Date.now() / 1000 < token.expiresAt - 60) return token
      return refresh(token)
    },
    session({ session, token }) {
      // Never carry the access token on the session (= client exposure). Expose only non-sensitive status flags.
      session.error = token.error
      return session
    },
  },
})
