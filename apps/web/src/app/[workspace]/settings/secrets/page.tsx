import { getTranslations } from 'next-intl/server'

import { secretsSchema, type SecretMeta } from '@/entities/secret'
import { SecretsManager } from '@/features/manage-workspace-secrets'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace › Secrets — shared (workspace-scoped) credentials only; personal (user) secrets live under Account.
// The store is one flat namespace, so this is a single list (secrets:read; management = secrets:write = admin).
export default async function SecretsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'secrets:read')
  const canWrite = can(principal?.roles, 'secrets:write')
  const header = <PageHeader title={t('secrets')} description={t('secretsDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let secrets: SecretMeta[] = []
  let error: string | undefined
  try {
    secrets = secretsSchema
      .parse(await controlPlane.listSecrets(ctx))
      .filter((secret) => secret.scope === 'workspace')
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <SecretsManager variant="workspace" secrets={secrets} canWrite={canWrite} />
      )}
    </div>
  )
}
