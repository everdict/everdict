import { getTranslations } from 'next-intl/server'

import { CapabilityStore } from '@/features/publish-capability'
// A server-only loader (controlPlane), so it is imported directly rather than through the barrel the client uses (following download-desktop/api).
import { loadStoreContext } from '@/features/publish-capability/api/store-context'
import { capabilitiesSchema, type Capability } from '@/entities/capability'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Store — it browses the public catalog only (public plus managed/first-party). What has already been brought into the workspace (adopted or
// imported) is distinguished by a row badge and the state filter. Publishing, editing and managing my own entries live on a separate page (store/mine). Viewing is capabilities:read.
export default async function StorePage() {
  const t = await getTranslations('capabilityStore')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'capabilities:read')
  const canWrite = can(principal?.roles, 'capabilities:write')
  const isAdmin = (principal?.roles ?? []).includes('admin')
  // The instance policy (operator env) — may a member publish public? An admin always can. UX gating only (the server enforces finally).
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
