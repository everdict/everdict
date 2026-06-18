import 'server-only'

import { cookies } from 'next/headers'
import { getToken } from 'next-auth/jwt'

import { env } from '@/shared/config/env'

// BFF: Keycloak 액세스 토큰을 서버에서만 읽는다(클라이언트 세션에는 절대 노출 안 함).
// Auth.js 가 httpOnly 암호화 쿠키에 보관한 JWT 를 getToken 으로 복호화해서 accessToken 만 꺼낸다.
// (getToken 은 분할 쿠키 .0/.1 도 SessionStore 로 재조립한다.)
export async function getAccessToken(): Promise<string | undefined> {
  if (!env.AUTH_SECRET) return undefined
  const cookieHeader = (await cookies()).toString()
  const req = { headers: { cookie: cookieHeader } }
  // 쿠키 이름은 secure 여부에 따라 __Secure- 접두사가 붙는다(https). 추론값 먼저, 실패 시 반대값.
  const inferred = (process.env.AUTH_URL ?? '').startsWith('https://')
  for (const secureCookie of [inferred, !inferred]) {
    const token = (await getToken({ req, secret: env.AUTH_SECRET, secureCookie })) as {
      accessToken?: string
    } | null
    if (token?.accessToken) return token.accessToken
  }
  return undefined
}
