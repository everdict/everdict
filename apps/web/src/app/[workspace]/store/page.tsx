import { getTranslations } from 'next-intl/server'

import { CapabilityStore } from '@/features/publish-capability'
// server-only 로더(controlPlane)라 클라이언트가 쓰는 배럴을 통하지 않고 직접 임포트한다(download-desktop/api 선례).
import { loadStoreContext } from '@/features/publish-capability/api/store-context'
import { capabilitiesSchema, type Capability } from '@/entities/capability'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Store — 공개 카탈로그만 브라우즈한다(공개 + 매니지드/첫당사자). 이미 워크스페이스에 데려온 것(채택/가져옴)은 행에
// 배지 + 상태 필터로 구분한다. 발행/편집·내 항목 관리는 별도 페이지(store/mine). capabilities:read 로 보기.
export default async function StorePage() {
  const t = await getTranslations('capabilityStore')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'capabilities:read')
  const canWrite = can(principal?.roles, 'capabilities:write')
  const isAdmin = (principal?.roles ?? []).includes('admin')
  // 인스턴스 정책(operator env) — 멤버도 public 발행 가능? admin 은 항상 가능. UX 게이팅용(서버가 최종 강제).
  const allowMemberPublicPublish = principal?.config?.allowMemberPublicPublish === true
  const header = <PageHeader title={t('title')} description={t('description')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
      </div>
    )
  }

  let publicCaps: Capability[] = []
  let error: string | undefined
  try {
    publicCaps = capabilitiesSchema.parse(await controlPlane.listPublicCapabilities(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const store = await loadStoreContext(ctx)

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : (
        <CapabilityStore
          items={publicCaps}
          variant="catalog"
          authors={store.authors}
          canWrite={canWrite}
          adoptedKeys={store.adoptedKeys}
          importedSkillKeys={store.importedSkillKeys}
          adoptedEnvironments={store.adoptedEnvironments}
          myWorkspaces={store.myWorkspaces}
          imageRegistries={store.imageRegistries}
          currentWorkspace={principal?.workspace ?? ''}
          isAdmin={isAdmin}
          allowMemberPublicPublish={allowMemberPublicPublish}
          {...(principal?.subject !== undefined ? { currentSubject: principal.subject } : {})}
        />
      )}
    </div>
  )
}
