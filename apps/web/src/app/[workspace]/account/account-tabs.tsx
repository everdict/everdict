'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { LeaveWorkspaceButton } from '@/features/leave-workspace'
import { ApiKeysManager } from '@/features/manage-api-keys'
import { SecretsManager } from '@/features/manage-workspace-secrets'
import { ProfileForm } from '@/features/update-profile'
import type { ApiKeyMeta } from '@/entities/api-key'
import type { SecretMeta } from '@/entities/secret'
import { Callout } from '@/shared/ui/callout'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

// Mirror just the needed shape locally to avoid pulling principal.ts (server-only) into the client.
interface AccountWorkspace {
  name: string
  role: string
}
interface AccountProfile {
  name?: string
  avatarUrl?: string
}
interface AccountPrincipal {
  subject: string
  workspace: string
  roles: string[]
  via: 'oidc' | 'api-key'
  email?: string
  workspaces?: AccountWorkspace[]
  profile?: AccountProfile
}

// User settings section switch — profile (edit) + leave workspace · personal secrets · API keys.
// (External account connections are replaced by the workspace-owned GitHub App/Mattermost — managed in Settings › Integrations)
export function AccountTabs({
  principal,
  personalSecrets,
  keys,
  keysError,
  initialTab,
}: {
  principal: AccountPrincipal
  personalSecrets: SecretMeta[]
  keys: ApiKeyMeta[]
  keysError?: string
  initialTab?: string // ?tab=…
}) {
  const t = useTranslations('accountPage')
  // Runners move to the runtimes page (execution-target surface) rather than the account — managed on one screen with the execution infra.
  const tabKeys = ['profile', 'secrets', 'keys']
  const defaultTab = initialTab && tabKeys.includes(initialTab) ? initialTab : 'profile'

  // Sync the current tab to ?tab= so it survives a refresh (update the URL via history.replaceState only, without re-requesting the server).
  const [tab, setTab] = useState(defaultTab)
  const onTabChange = (v: string) => {
    setTab(v)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', v)
    window.history.replaceState(null, '', url)
  }

  return (
    <Tabs value={tab} onValueChange={onTabChange} className="space-y-5">
      <TabsList>
        <TabsTrigger value="profile">{t('tabProfile')}</TabsTrigger>
        <TabsTrigger value="secrets">{t('tabSecrets')}</TabsTrigger>
        <TabsTrigger value="keys">{t('tabKeys')}</TabsTrigger>
      </TabsList>

      <TabsContent value="profile">
        <div className="max-w-2xl space-y-5">
          <ProfileForm
            email={principal.email}
            name={principal.profile?.name}
            avatarUrl={principal.profile?.avatarUrl}
          />

          {/* Leave workspace — based on the active workspace (hidden for api-key sessions) */}
          {principal.via === 'oidc' && principal.workspace && <LeaveWorkspaceButton />}
        </div>
      </TabsContent>

      <TabsContent value="secrets">
        {/* Personal secrets — self-managed (no admin needed). Other members can't see them. Referenced as "my personal" in the harness env. */}
        <SecretsManager variant="personal" secrets={personalSecrets} canWrite />
      </TabsContent>

      <TabsContent value="keys">
        {/* Personal API keys — self-managed (no admin needed). A key operates with my permissions. */}
        {keysError ? (
          <Callout tone="danger">{t('keysLoadError', { error: keysError })}</Callout>
        ) : (
          <ApiKeysManager keys={keys} canWrite />
        )}
      </TabsContent>
    </Tabs>
  )
}
