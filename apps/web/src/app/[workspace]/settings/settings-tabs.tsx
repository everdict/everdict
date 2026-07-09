'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { DeleteWorkspaceCard } from '@/features/delete-workspace'
import { BudgetManager } from '@/features/manage-budget'
import { CiLinksSettings } from '@/features/manage-ci-links'
import type { GithubAppNotice } from '@/features/manage-github-app'
import { InvitesManager } from '@/features/manage-invites'
import { MembersManager } from '@/features/manage-members'
import { WorkspaceRunnersManager } from '@/features/manage-workspace-runners'
import { SecretsManager } from '@/features/manage-workspace-secrets'
import { WorkspaceInfoCard } from '@/features/workspace-settings'
import type { BudgetResponse } from '@/entities/budget'
import type { CiLink } from '@/entities/ci-link'
import type { GithubAppView } from '@/entities/github-app'
import type { ImageRegistryConfig } from '@/entities/image-registry'
import type { MattermostConfig } from '@/entities/mattermost'
import type { Invite, Member } from '@/entities/member'
import type { RunnerMeta } from '@/entities/runner'
import type { SecretMeta } from '@/entities/secret'
import type { TraceSinkConfig } from '@/entities/trace-sink'
import type { TenantUsage } from '@/entities/usage'
import type { WorkspaceRecord } from '@/entities/workspace'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

import { IntegrationsPanel, type IntegrationKey } from './integrations-panel'

type TabKey = 'general' | 'secrets' | 'integrations' | 'ci' | 'runners' | 'budget' | 'members'

// For validating the ?app= deep link — the integrations panel's drill-in key (values outside these four are ignored).
const INTEGRATION_KEYS: IntegrationKey[] = ['github', 'mattermost', 'trace-sink', 'image-registry']

// Workspace settings tabs: general (info/policy/delete) · secrets · integrations (GitHub App/Mattermost/trace sink/image registry) · CI · shared runners · members.
// Tabs without permission are hidden. The "integrations" tab manages each integration via a summary list → "Manage" drill-in (IntegrationsPanel).
// Secrets are a single tab — the store is a flat, category-less namespace, so splitting into model keys/cluster credentials would show the same list twice.
export function SettingsTabs(props: {
  workspace?: WorkspaceRecord // Active workspace record (name/logo/owner) — only when settings:read
  isOwner: boolean // If owner, expose the danger zone (delete)
  secrets: SecretMeta[]
  githubApp: GithubAppView // Workspace-owned GitHub App integration (org installation→selected repos)
  githubAppNotice?: GithubAppNotice // Notice right after the installation callback redirect (?githubApp=installed / ?error=…)
  mattermost?: MattermostConfig // Workspace-owned Mattermost integration (completion/regression notifications)
  traceSinks: TraceSinkConfig[] // Workspace trace sinks (multiple — export scorecard detail results to the observability platform, selected per harness)
  imageRegistries: ImageRegistryConfig[] // Workspace image registries (multiple — classification baseline + push publishing)
  ciLinks: CiLink[] // CI repo link (repo↔harness slot = OIDC trust) list
  budget?: BudgetResponse // Enforcement budget (per-tenant cost/token/run caps that block runs with 402) — only when settings:read
  metered?: TenantUsage // Metered billing usage (LLM cost surface) — shown read-only in the budget tab (consolidated from the old /usage page)
  workspaceRunners: RunnerMeta[] // Workspace-shared runners (owner=ws:<workspace>) — team build server/CI (admin)
  members: Member[]
  invites: Invite[]
  canReadSettings: boolean
  canWriteSettings: boolean
  canReadSecrets: boolean
  canWriteSecrets: boolean
  canReadMembers: boolean
  canWriteMembers: boolean
  initialTab?: string // ?tab=… (e.g. the account→connections tab's "Integration settings →" deep link lands straight on the integrations tab)
  initialIntegration?: string // ?app=… — drill straight into a specific integration's detail within the integrations tab
}) {
  const t = useTranslations('settingsPage')
  const tabs: { key: TabKey; label: string; show: boolean }[] = [
    { key: 'general', label: t('tabGeneral'), show: props.canReadSettings },
    { key: 'secrets', label: t('tabSecrets'), show: props.canReadSecrets },
    { key: 'integrations', label: t('tabIntegrations'), show: props.canReadSettings },
    { key: 'ci', label: t('tabCi'), show: props.canReadSettings },
    { key: 'runners', label: t('tabRunners'), show: props.canWriteSettings },
    { key: 'budget', label: t('tabBudget'), show: props.canReadSettings },
    { key: 'members', label: t('tabMembers'), show: props.canReadMembers },
  ]
  const visible = tabs.filter((tab) => tab.show)
  // If ?tab= is one of the visible tabs, use it, otherwise the first shown tab.
  // model/cluster = old deep links from when secrets were two tabs — absorbed into the merged tab.
  const wantedTab =
    props.initialTab === 'model' || props.initialTab === 'cluster' ? 'secrets' : props.initialTab
  const requestedTab = visible.find((tab) => tab.key === wantedTab)?.key
  const defaultTab = requestedTab ?? visible[0]?.key ?? 'general'
  // Pass ?app= as the integrations panel's initial drill-in only when it's one of the four keys.
  const initialIntegration = INTEGRATION_KEYS.find((k) => k === props.initialIntegration)
  // Controlled tab — so the runners tab's "Install GitHub App" CTA can switch to the integrations tab (a same-page ?tab= link can't change state).
  const [tab, setTab] = useState<string>(defaultTab)

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-5">
      <TabsList>
        {visible.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="general">
        <div className="space-y-6">
          {props.workspace && (
            <WorkspaceInfoCard
              id={props.workspace.id}
              name={props.workspace.name}
              canWrite={props.canWriteSettings}
              {...(props.workspace.logoUrl !== undefined
                ? { logoUrl: props.workspace.logoUrl }
                : {})}
            />
          )}
          {props.isOwner && props.workspace && (
            <DeleteWorkspaceCard workspaceName={props.workspace.name} />
          )}
        </div>
      </TabsContent>
      <TabsContent value="secrets">
        <SecretsManager
          variant="workspace"
          secrets={props.secrets}
          canWrite={props.canWriteSecrets}
        />
      </TabsContent>
      <TabsContent value="integrations">
        {/* Workspace secret names for the GHE private-key · MM token pickers (values don't come through) — props.secrets is already workspace-scoped only. */}
        <IntegrationsPanel
          githubApp={props.githubApp}
          {...(props.githubAppNotice !== undefined
            ? { githubAppNotice: props.githubAppNotice }
            : {})}
          {...(props.mattermost !== undefined ? { mattermost: props.mattermost } : {})}
          traceSinks={props.traceSinks}
          imageRegistries={props.imageRegistries}
          canWrite={props.canWriteSettings}
          secretNames={props.secrets.map((s) => s.name)}
          {...(initialIntegration !== undefined ? { initialActive: initialIntegration } : {})}
        />
      </TabsContent>
      <TabsContent value="ci">
        <CiLinksSettings initialLinks={props.ciLinks} canWrite={props.canWriteSettings} />
      </TabsContent>
      <TabsContent value="runners">
        {/* For the GitHub Actions runner-registration picker — thread through the installation status (with allowed repos) that the integrations tab already receives. */}
        <WorkspaceRunnersManager
          runners={props.workspaceRunners}
          canWrite={props.canWriteSettings}
          githubApp={props.githubApp}
          onOpenIntegrations={() => setTab('integrations')}
        />
      </TabsContent>
      <TabsContent value="budget">
        {props.budget && (
          <BudgetManager
            usage={props.budget.usage}
            limit={props.budget.limit}
            {...(props.metered !== undefined ? { metered: props.metered } : {})}
            canWrite={props.canWriteSettings}
          />
        )}
      </TabsContent>
      <TabsContent value="members">
        <div className="space-y-8">
          <MembersManager members={props.members} canWrite={props.canWriteMembers} />
          {props.canWriteMembers && <InvitesManager invites={props.invites} canWrite />}
        </div>
      </TabsContent>
    </Tabs>
  )
}
