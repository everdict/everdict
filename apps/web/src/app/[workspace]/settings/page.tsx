import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { DeleteWorkspaceCard } from '@/features/delete-workspace'
import { resolveWorkspaceUrlBase, WorkspaceInfoCard } from '@/features/workspace-settings'
import { workspaceRecordSchema, type WorkspaceRecord } from '@/entities/workspace'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SettingsColumn } from '@/shared/ui/settings-column'

export const dynamic = 'force-dynamic'

// Old ?tab= deep links (from the former tabbed settings page + the GitHub App install callback that lands on
// ?tab=integrations&githubApp=installed) → the matching section route. model/cluster = the old split secret tabs.
const TAB_ROUTES: Record<string, string> = {
  secrets: 'secrets',
  model: 'secrets',
  cluster: 'secrets',
  models: 'models',
  integrations: 'integrations',
  ci: 'ci',
  runners: 'runners',
  budget: 'budget',
  members: 'members',
}

// Settings index = Workspace › General (workspace info + delete). Also the back-compat entry for legacy ?tab= links.
export default async function SettingsGeneralPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ tab?: string; app?: string; githubApp?: string; error?: string }>
}) {
  const { workspace } = await params
  const sp = await searchParams
  if (sp.tab !== undefined && sp.tab !== 'general') {
    const section = TAB_ROUTES[sp.tab]
    if (section) {
      const qs = new URLSearchParams()
      if (sp.app !== undefined) qs.set('app', sp.app)
      if (sp.githubApp !== undefined) qs.set('githubApp', sp.githubApp)
      if (sp.error !== undefined) qs.set('error', sp.error)
      const query = qs.toString()
      redirect(`/${workspace}/settings/${section}${query ? `?${query}` : ''}`)
    }
  }

  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'settings:read')
  const canWrite = can(principal?.roles, 'settings:write')
  const header = <PageHeader title={t('general')} description={t('generalDesc')} />
  if (!canRead) {
    return (
      <SettingsColumn>
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </SettingsColumn>
    )
  }

  let workspaceRecord: WorkspaceRecord | undefined
  let error: string | undefined
  try {
    workspaceRecord = workspaceRecordSchema.parse(await controlPlane.getWorkspace(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  // Deletion is owner (creator) only — the control plane enforces it; the UI exposes the danger zone only when owner.
  const isOwner = workspaceRecord !== undefined && workspaceRecord.owner === principal?.subject
  // Derive the workspace's canonical URL base from the actual request origin (or the WORKSPACE_URL_BASE override).
  const urlBase = await resolveWorkspaceUrlBase()

  return (
    <SettingsColumn>
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <div className="space-y-6">
          {workspaceRecord && (
            <WorkspaceInfoCard
              id={workspaceRecord.id}
              name={workspaceRecord.name}
              urlBase={urlBase}
              canWrite={canWrite}
              {...(workspaceRecord.logoUrl !== undefined
                ? { logoUrl: workspaceRecord.logoUrl }
                : {})}
            />
          )}
          {isOwner && workspaceRecord && (
            <DeleteWorkspaceCard workspaceName={workspaceRecord.name} />
          )}
        </div>
      )}
    </SettingsColumn>
  )
}
