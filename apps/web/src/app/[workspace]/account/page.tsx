import { apiKeysSchema, type ApiKeyMeta } from '@/entities/api-key'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { AccountTabs } from './account-tabs'

export const dynamic = 'force-dynamic'

// 유저 설정 페이지 — 프로필(읽기전용, GET /me) · 테마 · API 키(활성 워크스페이스, admin).
export default async function AccountPage() {
  const { principal, ctx } = await currentPrincipal()
  if (!principal) {
    return (
      <div className="space-y-6">
        <PageHeader title="계정" description="내 프로필과 API 키." />
        <EmptyState
          title="로그인이 필요합니다."
          hint="컨트롤플레인에서 신원을 확인할 수 없습니다."
        />
      </div>
    )
  }

  const canReadKeys = can(principal.roles, 'keys:read')
  const canWriteKeys = can(principal.roles, 'keys:write')

  let keys: ApiKeyMeta[] = []
  let keysError: string | undefined
  if (canReadKeys) {
    try {
      keys = apiKeysSchema.parse(await controlPlane.listKeys(ctx))
    } catch (e) {
      keysError = e instanceof Error ? e.message : String(e)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="계정" description="내 프로필 · 테마 · API 키." />
      <AccountTabs
        principal={principal}
        keys={keys}
        keysError={keysError}
        canReadKeys={canReadKeys}
        canWriteKeys={canWriteKeys}
      />
    </div>
  )
}
