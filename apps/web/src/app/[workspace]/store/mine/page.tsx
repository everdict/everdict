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

// My published — the capabilities my workspace published (every visibility). Publishing, editing, changing visibility and deleting happen here, and
// the store (the public catalog) is browse-only. First-party (managed) entries are not workspace-owned and are excluded from this list.
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
    // Of what I can see, only what MY workspace owns — somebody else's public/subset and the first-party ones are handled in the store.
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
