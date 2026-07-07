import 'server-only'

import { cookies } from 'next/headers'
import { getToken } from 'next-auth/jwt'

import { env } from '@/shared/config/env'

// BFF: read the Keycloak access token on the server only (never exposed to the client session).
// Decrypt the JWT that Auth.js keeps in the httpOnly encrypted cookie via getToken and extract only accessToken.
// (getToken also reassembles split cookies .0/.1 via SessionStore.)
export async function getAccessToken(): Promise<string | undefined> {
  if (!env.AUTH_SECRET) return undefined
  const cookieHeader = (await cookies()).toString()
  const req = { headers: { cookie: cookieHeader } }
  // The cookie name gets a __Secure- prefix depending on secure (https). Try the inferred value first, the opposite on failure.
  const inferred = (process.env.AUTH_URL ?? '').startsWith('https://')
  for (const secureCookie of [inferred, !inferred]) {
    const token = (await getToken({ req, secret: env.AUTH_SECRET, secureCookie })) as {
      accessToken?: string
    } | null
    if (token?.accessToken) return token.accessToken
  }
  return undefined
}
