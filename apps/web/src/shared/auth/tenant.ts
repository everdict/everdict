import 'server-only'

import { keycloakConfigured } from '@/shared/config/env'
import { auth } from './auth'

// 현재 요청의 테넌트 + 인증 여부. Keycloak 미설정(dev)에선 tenant="default", authed=false.
export async function currentTenant(): Promise<{ tenant: string; authed: boolean }> {
  if (!keycloakConfigured) return { tenant: 'default', authed: false }
  const session = await auth()
  return { tenant: session?.tenant ?? 'default', authed: Boolean(session) }
}
