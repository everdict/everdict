import { getTranslations } from 'next-intl/server'

import { apiKeysSchema, type ApiKeyMeta } from '@/entities/api-key'
import { ApiKeysManager } from '@/features/manage-api-keys'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Account › API keys — personal keys (self-scoped, no role gate). GET /keys returns only my own; a key acts with my permissions.
export default async function ApiKeysPage() {
  const t = await getTranslations('settingsNav')
  const { principal, ctx } = await currentPrincipal()
  if (!principal) {
    const a = await getTranslations('accountPage')
    return (
      <div className="space-y-6">
        <PageHeader title={t('apiKeys')} description={t('apiKeysDesc')} />
        <EmptyState title={a('signedOutTitle')} hint={a('signedOutHint')} />
      </div>
    )
  }

  let keys: ApiKeyMeta[] = []
  let keysError: string | undefined
  try {
    keys = apiKeysSchema.parse(await controlPlane.listKeys(ctx))
  } catch (e) {
    keysError = e instanceof Error ? e.message : String(e)
  }
  const a = await getTranslations('accountPage')

  return (
    <div className="space-y-6">
      <PageHeader title={t('apiKeys')} description={t('apiKeysDesc')} />
      {keysError ? (
        <Callout tone="danger">{a('keysLoadError', { error: keysError })}</Callout>
      ) : (
        <ApiKeysManager keys={keys} canWrite />
      )}
    </div>
  )
}
