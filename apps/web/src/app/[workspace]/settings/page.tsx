import { getTranslations } from 'next-intl/server'

import { budgetResponseSchema, type BudgetResponse } from '@/entities/budget'
import { ciLinksResponseSchema, type CiLink } from '@/entities/ci-link'
import { githubAppViewSchema, type GithubAppView } from '@/entities/github-app'
import { imageRegistriesResponseSchema, type ImageRegistryConfig } from '@/entities/image-registry'
import { mattermostResponseSchema, type MattermostConfig } from '@/entities/mattermost'
import { invitesSchema, membersSchema, type Invite, type Member } from '@/entities/member'
import { runnersResponseSchema, type RunnerMeta } from '@/entities/runner'
import { secretsSchema, type SecretMeta } from '@/entities/secret'
import { traceSinksResponseSchema, type TraceSinkConfig } from '@/entities/trace-sink'
import { traceSourcesResponseSchema, type TraceSourceConfig } from '@/entities/trace-source'
import { tenantUsageSchema, type TenantUsage } from '@/entities/usage'
import { workspaceRecordSchema, type WorkspaceRecord } from '@/entities/workspace'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { SettingsTabs } from './settings-tabs'

export const dynamic = 'force-dynamic'

// Workspace settings — policy · secrets · members (+ the roster of applications connected to this workspace, read-only).
// Connecting/disconnecting (managing) external account connections is personally-owned, so it lives on the account page. This roster is by the workspace as created (members:read).
// searchParams.tab — received so the account→connections tab's "Integration settings →" deep link lands straight on the integrations tab.
// searchParams.app — drills straight into a specific integration's detail (github/mattermost/trace-sink/image-registry) within the integrations tab.
// searchParams.githubApp/error — result notice from the GitHub App installation callback redirect (shown on the integrations tab).
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; app?: string; githubApp?: string; error?: string }>
}) {
  const sp = await searchParams
  const t = await getTranslations('settingsPage')
  const githubAppNotice =
    sp.githubApp === 'installed' || sp.error !== undefined
      ? {
          ...(sp.githubApp === 'installed' ? { installed: true } : {}),
          ...(sp.error !== undefined ? { error: sp.error } : {}),
        }
      : undefined
  const { principal, ctx } = await currentPrincipal()
  const canReadSettings = can(principal?.roles, 'settings:read')
  const canWriteSettings = can(principal?.roles, 'settings:write')
  const canReadSecrets = can(principal?.roles, 'secrets:read')
  const canWriteSecrets = can(principal?.roles, 'secrets:write')
  const canReadMembers = can(principal?.roles, 'members:read')
  const canWriteMembers = can(principal?.roles, 'members:write')
  // Budget + usage are readable by members (viewer+, reuses scorecards:read); editing the limit stays admin (settings:write).
  const canReadUsage = can(principal?.roles, 'scorecards:read')

  let workspace: WorkspaceRecord | undefined
  let secrets: SecretMeta[] = []
  let githubApp: GithubAppView = { registrations: [], installations: [] }
  let mattermost: MattermostConfig | undefined
  let traceSinks: TraceSinkConfig[] = []
  let traceSources: TraceSourceConfig[] = []
  let imageRegistries: ImageRegistryConfig[] = []
  let ciLinks: CiLink[] = []
  let budget: BudgetResponse | undefined
  let metered: TenantUsage | undefined
  let workspaceRunners: RunnerMeta[] = []
  let members: Member[] = []
  let invites: Invite[] = []
  // Per-section soft-fail: one failing fetch (a missing route on a stale control plane, one misbehaving
  // integration) must not nuke the whole settings page — the failed sections are named in a callout and
  // everything else renders. Only when EVERY attempted section failed do we show the full-page error.
  const failedSections: string[] = []
  let attempted = 0
  let firstError: string | undefined
  const attempt = async <T,>(section: string, fn: () => Promise<T>): Promise<T | undefined> => {
    attempted += 1
    try {
      return await fn()
    } catch (e) {
      failedSections.push(section)
      firstError ??= e instanceof Error ? e.message : String(e)
      return undefined
    }
  }
  if (canReadSettings) {
    workspace = await attempt('workspace', async () =>
      workspaceRecordSchema.parse(await controlPlane.getWorkspace(ctx))
    )
    // Workspace-owned GitHub App integration (org installation→selected repos). settings:read (admin).
    githubApp =
      (await attempt('github-app', async () =>
        githubAppViewSchema.parse(await controlPlane.getGithubApp(ctx))
      )) ?? githubApp
    // Workspace-owned Mattermost integration (completion/regression notifications). Replaces personal-connection notifications. settings:read (admin).
    mattermost = await attempt(
      'mattermost',
      async () => mattermostResponseSchema.parse(await controlPlane.getMattermost(ctx)).config
    )
    // Workspace trace sinks (multiple — selected per harness). The read itself is viewer+, but the management UI is this tab.
    traceSinks =
      (await attempt(
        'trace-sinks',
        async () => traceSinksResponseSchema.parse(await controlPlane.listTraceSinks(ctx)).sinks
      )) ?? []
    // Workspace trace sources (multiple — selected per harness). The read itself is viewer+, but the management UI is this tab.
    traceSources =
      (await attempt(
        'trace-sources',
        async () =>
          traceSourcesResponseSchema.parse(await controlPlane.listTraceSources(ctx)).sources
      )) ?? []
    // Workspace image registries (multiple — classification baseline + everdict image push target). The read itself is viewer+, but the management UI is this tab.
    imageRegistries =
      (await attempt(
        'image-registries',
        async () =>
          imageRegistriesResponseSchema.parse(await controlPlane.listImageRegistries(ctx))
            .registries
      )) ?? []
    // CI repo link (repo↔harness slot = OIDC trust) — the link's existence is that repo's keyless CI trust. Removal is admin.
    ciLinks =
      (await attempt(
        'ci-links',
        async () => ciLinksResponseSchema.parse(await controlPlane.listCiLinks(ctx)).links
      )) ?? []
  }
  // Budget (enforcement caps + committed usage) + metered billing usage — both readable by members (viewer+). The
  // limit form is editable only by admins (canWriteSettings); members see it read-only. Consolidated from the old /usage page.
  if (canReadUsage) {
    budget = await attempt('budget', async () =>
      budgetResponseSchema.parse(await controlPlane.getBudget(ctx))
    )
    metered = await attempt('usage', async () =>
      tenantUsageSchema.parse(await controlPlane.getUsage(ctx))
    )
  }
  // Workspace-shared runners (owner=ws:<workspace>) — team build server/CI. Register/read/remove are all admin (settings:write).
  if (canWriteSettings) {
    workspaceRunners =
      (await attempt(
        'runners',
        async () =>
          runnersResponseSchema.parse(await controlPlane.listWorkspaceOwnedRunners(ctx)).runners
      )) ?? []
  }
  // Workspace settings show only shared (workspace) secrets — my personal (user) secrets that GET /secrets mixes in are managed on the account page.
  if (canReadSecrets)
    secrets =
      (await attempt('secrets', async () =>
        secretsSchema
          .parse(await controlPlane.listSecrets(ctx))
          .filter((s) => s.scope === 'workspace')
      )) ?? []
  if (canReadMembers)
    members =
      (await attempt('members', async () =>
        membersSchema.parse(await controlPlane.listMembers(ctx))
      )) ?? []
  if (canWriteMembers)
    invites =
      (await attempt('invites', async () =>
        invitesSchema.parse(await controlPlane.listInvites(ctx))
      )) ?? []
  const allFailed = attempted > 0 && failedSections.length === attempted
  const error = allFailed ? firstError : undefined

  const canReadAny = canReadSettings || canReadSecrets || canReadMembers || canReadUsage
  // Deletion is owner (creator) only — the control plane enforces it ultimately, and the UI exposes the danger zone only when owner.
  const isOwner = workspace !== undefined && workspace.owner === principal?.subject

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      {!canReadAny ? (
        <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
      ) : error !== undefined ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : (
        <>
          {failedSections.length > 0 && (
            <Callout tone="danger">
              {t('partialError', { sections: failedSections.join(', '), error: firstError ?? '' })}
            </Callout>
          )}
          <SettingsTabs
            isOwner={isOwner}
            {...(workspace !== undefined ? { workspace } : {})}
            secrets={secrets}
            githubApp={githubApp}
            {...(githubAppNotice !== undefined ? { githubAppNotice } : {})}
            {...(mattermost !== undefined ? { mattermost } : {})}
            traceSinks={traceSinks}
            traceSources={traceSources}
            imageRegistries={imageRegistries}
            ciLinks={ciLinks}
            {...(budget !== undefined ? { budget } : {})}
            {...(metered !== undefined ? { metered } : {})}
            workspaceRunners={workspaceRunners}
            members={members}
            invites={invites}
            canReadSettings={canReadSettings}
            canWriteSettings={canWriteSettings}
            canReadSecrets={canReadSecrets}
            canWriteSecrets={canWriteSecrets}
            canReadMembers={canReadMembers}
            canWriteMembers={canWriteMembers}
            canReadUsage={canReadUsage}
            {...(sp.tab !== undefined ? { initialTab: sp.tab } : {})}
            {...(sp.app !== undefined ? { initialIntegration: sp.app } : {})}
          />
        </>
      )}
    </div>
  )
}
