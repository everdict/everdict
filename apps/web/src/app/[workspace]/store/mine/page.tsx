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

// My published — 내 워크스페이스가 발행한 capability(모든 공개범위). 여기서 발행·편집·공개범위 변경·삭제하고, 스토어(공개
// 카탈로그)는 브라우즈 전용이다. 첫당사자(매니지드) 항목은 워크스페이스 소유가 아니라 목록에서 제외된다.
export default async function MyPublishedPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const t = await getTranslations('capabilityStore')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'capabilities:read')
  const canWrite = can(principal?.roles, 'capabilities:write')
  const isAdmin = (principal?.roles ?? []).includes('admin')
  const allowMemberPublicPublish = principal?.config?.allowMemberPublicPublish === true
  const currentWorkspace = principal?.workspace ?? workspace
  const header = <PageHeader title={t('minePageTitle')} description={t('minePageDescription')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
      </div>
    )
  }

  let mine: Capability[] = []
  let error: string | undefined
  try {
    // 내가 볼 수 있는 것 중 내 워크스페이스가 소유한 것만 — 남의 public/subset·첫당사자는 스토어에서 다룬다.
    mine = capabilitiesSchema
      .parse(await controlPlane.listCapabilities(ctx))
      .filter((c) => c.tenant === currentWorkspace)
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
          items={mine}
          variant="mine"
          authors={store.authors}
          canWrite={canWrite}
          adoptedKeys={store.adoptedKeys}
          importedSkillKeys={store.importedSkillKeys}
          adoptedEnvironments={store.adoptedEnvironments}
          myWorkspaces={store.myWorkspaces}
          imageRegistries={store.imageRegistries}
          currentWorkspace={currentWorkspace}
          isAdmin={isAdmin}
          allowMemberPublicPublish={allowMemberPublicPublish}
          {...(principal?.subject !== undefined ? { currentSubject: principal.subject } : {})}
        />
      )}
    </div>
  )
}
