import { getTranslations } from 'next-intl/server'

import { SecretsManager } from '@/features/manage-workspace-secrets'
import { secretsSchema, type SecretMeta } from '@/entities/secret'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Account › Personal secrets — my own (user-scoped) secrets. GET /secrets returns only mine; self-managed (no role gate).
// Referenced as "my personal" in the harness env; other members can't see them.
export default async function PersonalSecretsPage() {
  const t = await getTranslations('settingsNav')
  const { principal, ctx } = await currentPrincipal()
  if (!principal) {
    const a = await getTranslations('accountPage')
    return (
      <div className="space-y-6">
        <PageHeader title={t('personalSecrets')} description={t('personalSecretsDesc')} />
        <EmptyState title={a('signedOutTitle')} hint={a('signedOutHint')} />
      </div>
    )
  }

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
      <PageHeader title={t('personalSecrets')} description={t('personalSecretsDesc')} />
      <SecretsManager variant="personal" secrets={personalSecrets} canWrite />
    </div>
  )
}
