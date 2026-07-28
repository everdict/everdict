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

// Settings › Agent › Tools — the mcp/code tool capabilities this workspace authors for its agent: publish, edit,
// version, change reach, delete, adopt. Discovery of OTHER workspaces' tools stays in the store (browse-only catalog);
// skills and environments each have their own settings home.
export default async function AgentToolsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'capabilities:read')
  const canWrite = can(principal?.roles, 'capabilities:write')
  const canAdopt = can(principal?.roles, 'agents:write')
  const canImportEnvironment = can(principal?.roles, 'settings:write')
  const isAdmin = (principal?.roles ?? []).includes('admin')
  const allowMemberPublicPublish = principal?.config?.allowMemberPublicPublish === true
  const currentWorkspace = principal?.workspace ?? ''
  const header = <PageHeader title={t('tools')} description={t('toolsDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let tools: Capability[] = []
  let error: string | undefined
  try {
    // 내 워크스페이스가 소유한 도구(mcp/code)만 — 남의 발행물은 스토어(카탈로그)에서 브라우즈·채택한다.
    tools = capabilitiesSchema
      .parse(await controlPlane.listCapabilities(ctx))
      .filter(
        (c) => c.tenant === currentWorkspace && (c.spec.type === 'mcp' || c.spec.type === 'code')
      )
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const store = await loadStoreContext(ctx)

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <CapabilityStore
          items={tools}
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
      )}
    </div>
  )
}
