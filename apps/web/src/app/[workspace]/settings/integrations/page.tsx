import { getTranslations } from 'next-intl/server'

import { githubAppViewSchema, type GithubAppView } from '@/entities/github-app'
import { imageRegistriesResponseSchema, type ImageRegistryConfig } from '@/entities/image-registry'
import { mattermostResponseSchema, type MattermostResponse } from '@/entities/mattermost'
import { secretsSchema } from '@/entities/secret'
import type { GithubAppNotice } from '@/features/manage-github-app'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { IntegrationsPanel, type IntegrationKey } from '../integrations-panel'

export const dynamic = 'force-dynamic'

// Each integration is a per-integration summary row → "Manage" drill-in inside this one page (not a sidebar item).
const INTEGRATION_KEYS: IntegrationKey[] = ['github', 'mattermost', 'image-registry']

// Per-section soft-fail: one misbehaving integration must not blank the page. Each read falls back to a default.
async function soft<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

// Workspace › Integrations — GitHub App · Mattermost · trace sinks/sources · image registries (settings:read; management = admin).
// ?app= drills straight into one integration; ?githubApp=installed / ?error= is the GitHub App install-callback notice (opens the GitHub detail).
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string; githubApp?: string; error?: string }>
}) {
  const sp = await searchParams
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'settings:read')
  const canWrite = can(principal?.roles, 'settings:write')
  const header = <PageHeader title={t('integrations')} description={t('integrationsDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  const githubAppNotice: GithubAppNotice | undefined =
    sp.githubApp === 'installed' || sp.error !== undefined
      ? {
          ...(sp.githubApp === 'installed' ? { installed: true } : {}),
          ...(sp.error !== undefined ? { error: sp.error } : {}),
        }
      : undefined

  const githubApp: GithubAppView = await soft(
    async () => githubAppViewSchema.parse(await controlPlane.getGithubApp(ctx)),
    { installations: [], providers: { githubCom: false } }
  )
  // Mattermost status: host = operator env server URL (absent = unavailable), config = the workspace registration.
  const mattermost: MattermostResponse = await soft(
    async () => mattermostResponseSchema.parse(await controlPlane.getMattermost(ctx)),
    {}
  )
  const imageRegistries: ImageRegistryConfig[] = await soft(
    async () =>
      imageRegistriesResponseSchema.parse(await controlPlane.listImageRegistries(ctx)).registries,
    []
  )
  // Workspace secret names for the GHE private-key · Mattermost token pickers (values never come through).
  const secretNames: string[] = await soft(
    async () =>
      secretsSchema
        .parse(await controlPlane.listSecrets(ctx))
        .filter((secret) => secret.scope === 'workspace')
        .map((secret) => secret.name),
    []
  )

  const initialActive = INTEGRATION_KEYS.find((k) => k === sp.app)

  return (
    <div className="space-y-6">
      {header}
      <IntegrationsPanel
        githubApp={githubApp}
        {...(githubAppNotice !== undefined ? { githubAppNotice } : {})}
        {...(mattermost !== undefined ? { mattermost } : {})}
        imageRegistries={imageRegistries}
        canWrite={canWrite}
        secretNames={secretNames}
        {...(initialActive !== undefined ? { initialActive } : {})}
      />
    </div>
  )
}
