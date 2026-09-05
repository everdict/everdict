import { getTranslations } from 'next-intl/server'

// A server-only loader (controlPlane), so it is imported directly rather than through the barrel the client uses (following download-desktop/api).
import { loadEnvironmentContext } from '@/features/publish-capability/api/environment-context'
import { capabilitiesSchema, type Capability } from '@/entities/capability'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { SettingsEnvironments } from './settings-environments'
import { EnvironmentRegistry, loadEnvironments } from '@/features/browse-environments'

export const dynamic = 'force-dynamic'

// Settings › Workspace › Environments — the evaluation environments this workspace can use, in ONE list: the environments authored here
// (registration, sharing, versions) and those imported from the store (pull verification), managed in the environment's own vocabulary.
// Discovering and importing somebody else's publications is the store's (the catalog) — only a link is offered here.
export default async function EnvironmentsSettingsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const tEnv = await getTranslations('settingsEnvironments')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'capabilities:read')
  const canWrite = can(principal?.roles, 'capabilities:write')
  const canImport = can(principal?.roles, 'settings:write')
  const isAdmin = (principal?.roles ?? []).includes('admin')
  const canPublishPublic = isAdmin || principal?.config?.allowMemberPublicPublish === true
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

  let authored: Capability[] = []
  let error: string | undefined
  try {
    // Only environment images MY workspace authored and owns — somebody else's publications are browsed and imported from the store (the catalog).
    authored = capabilitiesSchema
      .parse(await controlPlane.listCapabilities(ctx))
      .filter((cap) => cap.tenant === currentWorkspace && cap.spec.type === 'environment')
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const context = await loadEnvironmentContext(ctx)
  // The registry read is carried as a VALUE — a failure here must not take the image list above down.
  const registry = await loadEnvironments(ctx)

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <SettingsEnvironments
          authored={authored}
          imported={context.adoptedEnvironments}
          authors={context.authors}
          currentWorkspace={currentWorkspace}
          isAdmin={isAdmin}
          canWrite={canWrite}
          canImport={canImport}
          canPublishPublic={canPublishPublic}
          myWorkspaces={context.myWorkspaces}
          imageRegistries={context.imageRegistries}
          {...(principal?.subject !== undefined ? { currentSubject: principal.subject } : {})}
        />
      )}

      {/* …and the registry itself — the entity a case points at with `env: {kind: "ref"}` and a batch seals
          the resolved version of. The imported environments above are IMAGES (bytes); this is the world
          those bytes make, and only the second is an identity axis a batch can seal. Two pages would make a
          reader memorise which one holds which noun. */}
      <div className="border-t pt-6">
        <h2 className="mb-3 text-[11px] font-[510] uppercase tracking-wide text-faint">
          {tEnv('registryHeading')}
        </h2>
        <EnvironmentRegistry
          {...(registry.list ? { list: registry.list } : {})}
          {...(registry.error !== undefined ? { error: registry.error } : {})}
          canTag={canWrite}
        />
      </div>
    </div>
  )
}
