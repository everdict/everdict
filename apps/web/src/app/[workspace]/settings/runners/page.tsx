import { getTranslations } from 'next-intl/server'

import { githubAppViewSchema, type GithubAppView } from '@/entities/github-app'
import { runnersResponseSchema, type RunnerMeta } from '@/entities/runner'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { RunnersSection } from './runners-section'

export const dynamic = 'force-dynamic'

// Workspace › Runners — workspace-shared runners (owner=ws:<workspace>), the team's build server/CI. Register/read/remove are all admin (settings:write).
export default async function RunnersPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canWrite = can(principal?.roles, 'settings:write')
  const header = <PageHeader title={t('runners')} description={t('runnersDesc')} />
  if (!canWrite) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let runners: RunnerMeta[] = []
  // GitHub App installation snapshot for the Actions runner-registration picker (same snapshot as Integrations).
  let githubApp: GithubAppView = { installations: [], providers: { githubCom: false } }
  let error: string | undefined
  try {
    runners = runnersResponseSchema.parse(await controlPlane.listWorkspaceOwnedRunners(ctx)).runners
    githubApp = githubAppViewSchema.parse(await controlPlane.getGithubApp(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <RunnersSection
          workspace={workspace}
          runners={runners}
          canWrite={canWrite}
          githubApp={githubApp}
        />
      )}
    </div>
  )
}
