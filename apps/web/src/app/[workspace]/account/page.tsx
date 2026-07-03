import { apiKeysSchema, type ApiKeyMeta } from '@/entities/api-key'
import {
  connectionsResponseSchema,
  type ConnectionMeta,
  type ProviderInfo,
} from '@/entities/connection'
import { secretsSchema, type SecretMeta } from '@/entities/secret'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { AccountTabs } from './account-tabs'

export const dynamic = 'force-dynamic'

// 유저 설정 페이지 — 프로필(수정) · 워크스페이스 나가기 · 연결된 계정(개인 소유 OAuth) · API 키(활성 워크스페이스, admin).
// 연결된 계정은 워크스페이스가 아닌 개인 소유라 여기(계정)에 있다. searchParams 는 OAuth 콜백 복귀(?tab=connections&connected/error).
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; connected?: string; error?: string }>
}) {
  const sp = await searchParams
  const { principal, ctx } = await currentPrincipal()
  if (!principal) {
    return (
      <div className="space-y-6">
        <PageHeader title="계정" description="내 프로필과 API 키." />
        <EmptyState
          title="로그인이 필요해요."
          hint="로그인 정보를 확인할 수 없어요. 다시 로그인해주세요."
        />
      </div>
    )
  }

  const canReadKeys = can(principal.roles, 'keys:read')
  const canWriteKeys = can(principal.roles, 'keys:write')
  // 미설정 self-hosted provider 행에 통합 설정 딥링크를 보일지 — 실제 통합 등록 권한(settings:write)이 있을 때만.
  const canManageIntegrations = can(principal.roles, 'settings:write')

  let keys: ApiKeyMeta[] = []
  let keysError: string | undefined
  if (canReadKeys) {
    try {
      keys = apiKeysSchema.parse(await controlPlane.listKeys(ctx))
    } catch (e) {
      keysError = e instanceof Error ? e.message : String(e)
    }
  }

  // 연결된 계정 — 개인 소유라 역할 게이트 없이 본인(subject)의 연결만 조회. 실패해도 페이지는 렌더(빈 목록).
  let connections: ConnectionMeta[] = []
  let providers: ProviderInfo[] = []
  try {
    const r = connectionsResponseSchema.parse(await controlPlane.listConnections(ctx))
    connections = r.connections
    providers = r.providers
  } catch {
    // 컨트롤플레인 연결 서비스 미설정/실패 — 빈 목록으로 폴백(프로필·키 탭은 그대로 동작).
  }

  // 내 개인(user) 시크릿 — GET /secrets 는 항상 본인 것만 포함(공유는 admin만). 셀프 관리라 역할 게이트 없음.
  let personalSecrets: SecretMeta[] = []
  try {
    personalSecrets = secretsSchema
      .parse(await controlPlane.listSecrets(ctx))
      .filter((s) => s.scope === 'user')
  } catch {
    // 시크릿 저장소 미설정/실패 — 빈 목록으로 폴백.
  }

  return (
    <div className="space-y-6">
      <PageHeader title="계정" description="내 프로필 · 워크스페이스 · API 키." />
      <AccountTabs
        principal={principal}
        connections={connections}
        providers={providers}
        canManageIntegrations={canManageIntegrations}
        personalSecrets={personalSecrets}
        keys={keys}
        keysError={keysError}
        canReadKeys={canReadKeys}
        canWriteKeys={canWriteKeys}
        {...(sp.tab !== undefined ? { initialTab: sp.tab } : {})}
        {...(sp.connected !== undefined ? { connected: sp.connected } : {})}
        {...(sp.error !== undefined ? { connectError: sp.error } : {})}
      />
    </div>
  )
}
