import { getTranslations } from 'next-intl/server'

import { ciLinksResponseSchema, type CiLink } from '@/entities/ci-link'
import { CiLinksSettings } from '@/features/manage-ci-links'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace › CI — repo↔harness slot links (each = an OIDC trust policy for keyless CI evaluation). settings:read (admin).
export default async function CiPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'settings:read')
  const canWrite = can(principal?.roles, 'settings:write')
  const header = <PageHeader title={t('ci')} description={t('ciDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let ciLinks: CiLink[] = []
  let error: string | undefined
  try {
    ciLinks = ciLinksResponseSchema.parse(await controlPlane.listCiLinks(ctx)).links
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <CiLinksSettings initialLinks={ciLinks} canWrite={canWrite} />
      )}
    </div>
  )
}
