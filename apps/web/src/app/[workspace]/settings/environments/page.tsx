import { getTranslations } from 'next-intl/server'

import { CapabilityStore, EnvironmentInventory } from '@/features/publish-capability'
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

// Settings › Workspace › Environments — eval-environment images as a workspace concern: the environment capabilities
// this workspace authors (publish/version/reach) plus the imported-environment inventory (what was brought in from the
// store, with pull-usability verification). Discovery/import of other workspaces' environments stays in the store.
export default async function EnvironmentsSettingsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const c = await getTranslations('capabilityStore')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'capabilities:read')
  const canWrite = can(principal?.roles, 'capabilities:write')
  const canAdopt = can(principal?.roles, 'agents:write')
  const canImportEnvironment = can(principal?.roles, 'settings:write')
  const isAdmin = (principal?.roles ?? []).includes('admin')
  const allowMemberPublicPublish = principal?.config?.allowMemberPublicPublish === true
  const currentWorkspace = principal?.workspace ?? ''
  const header = <PageHeader title={t('environments')} description={t('environmentsDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let environments: Capability[] = []
  let error: string | undefined
  try {
    // 내 워크스페이스가 저작·소유한 환경 이미지만 — 남의 발행물은 스토어(카탈로그)에서 브라우즈·가져오기 한다.
    environments = capabilitiesSchema
      .parse(await controlPlane.listCapabilities(ctx))
      .filter((cap) => cap.tenant === currentWorkspace && cap.spec.type === 'environment')
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const store = await loadStoreContext(ctx)

  return (
    <div className="space-y-8">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <>
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">{c('envPublishedSection')}</h2>
              <p className="text-[12.5px] text-muted-foreground">{c('envPublishedHint')}</p>
            </div>
            <CapabilityStore
              items={environments}
              variant="mine"
              authors={store.authors}
              canWrite={canWrite}
              canAdopt={canAdopt}
              canImportEnvironment={canImportEnvironment}
              adoptedKeys={store.adoptedKeys}
              adoptedEnvironments={store.adoptedEnvironments}
              secretNames={store.secretNames}
              myWorkspaces={store.myWorkspaces}
              imageRegistries={store.imageRegistries}
              currentWorkspace={currentWorkspace}
              isAdmin={isAdmin}
              allowMemberPublicPublish={allowMemberPublicPublish}
              {...(principal?.subject !== undefined ? { currentSubject: principal.subject } : {})}
            />
          </section>
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">{c('envImportedSection')}</h2>
              <p className="text-[12.5px] text-muted-foreground">{c('envImportedHint')}</p>
            </div>
            <EnvironmentInventory
              items={store.adoptedEnvironments}
              canManage={canImportEnvironment}
            />
          </section>
        </>
      )}
    </div>
  )
}
