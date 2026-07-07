import { getTranslations } from 'next-intl/server'

import { apiKeysSchema, type ApiKeyMeta } from '@/entities/api-key'
import { secretsSchema, type SecretMeta } from '@/entities/secret'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { AccountTabs } from './account-tabs'

export const dynamic = 'force-dynamic'

// User settings page — profile (edit) · leave workspace · personal secrets · API keys (active workspace).
// (External account connections are replaced by the workspace-owned GitHub App/Mattermost — managed in Settings › Integrations)
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const sp = await searchParams
  const t = await getTranslations('accountPage')
  const { principal, ctx } = await currentPrincipal()
  if (!principal) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('title')} description={t('descriptionSignedOut')} />
        <EmptyState title={t('signedOutTitle')} hint={t('signedOutHint')} />
      </div>
    )
  }

  // Personal API keys — self-scoped (no role gate). GET /keys returns only my own (subject) keys. The page renders even if it fails.
  let keys: ApiKeyMeta[] = []
  let keysError: string | undefined
  try {
    keys = apiKeysSchema.parse(await controlPlane.listKeys(ctx))
  } catch (e) {
    keysError = e instanceof Error ? e.message : String(e)
  }

  // My personal (user) secrets — GET /secrets always includes only my own (shared is admin-only). Self-managed, so no role gate.
  let personalSecrets: SecretMeta[] = []
  try {
    personalSecrets = secretsSchema
      .parse(await controlPlane.listSecrets(ctx))
      .filter((s) => s.scope === 'user')
  } catch {
    // Secret store unconfigured/failed — fall back to an empty list.
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <AccountTabs
        principal={principal}
        personalSecrets={personalSecrets}
        keys={keys}
        keysError={keysError}
        {...(sp.tab !== undefined ? { initialTab: sp.tab } : {})}
      />
    </div>
  )
}
