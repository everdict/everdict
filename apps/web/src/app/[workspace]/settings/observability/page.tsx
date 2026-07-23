import { getTranslations } from 'next-intl/server'

import { TraceBrowser } from '@/features/browse-traces'
import { TraceSourceManager } from '@/features/manage-trace-source'
import { secretsSchema } from '@/entities/secret'
import { traceSourcesResponseSchema, type TraceSourcesResponse } from '@/entities/trace-source'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace observability — the home for the team's trace platforms. Admins register/edit the ONE "Trace Source" pool
// (a platform is used to pull traces from and/or export judged results to, chosen per harness); everyone browses the
// traces + metrics a registered platform holds, like the platform's own UI (also the judge wizard's sample picker).
// Read = harnesses:read (viewer+); registration form = settings:write (admin).
export default async function ObservabilityPage() {
  const t = await getTranslations('observabilityPage')
  const { principal, ctx } = await currentPrincipal()
  const header = <PageHeader title={t('title')} description={t('description')} />

  if (!can(principal?.roles, 'harnesses:read')) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
      </div>
    )
  }

  const canWrite = can(principal?.roles, 'settings:write')

  let roster: TraceSourcesResponse | undefined
  let error: string | undefined
  try {
    roster = traceSourcesResponseSchema.parse(await controlPlane.listTraceSources(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // Workspace secret names for the register form's auth picker (admin only; the values never come through). Soft-fail.
  let secretNames: string[] = []
  if (canWrite) {
    try {
      secretNames = secretsSchema
        .parse(await controlPlane.listSecrets(ctx))
        .filter((secret) => secret.scope === 'workspace')
        .map((secret) => secret.name)
    } catch {
      // A failed secret list just leaves the picker empty — registration still works with an unauthenticated endpoint.
    }
  }

  return (
    <div className="space-y-8">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{error}</Callout>
      ) : (
        <>
          <TraceSourceManager
            sources={roster?.sources ?? []}
            canWrite={canWrite}
            secretNames={secretNames}
          />
          <div className="border-t pt-6">
            {/* Opt out of auto-pull here: registering/listing a source shouldn't fire a slow platform query — the user
                selects a source and presses Fetch. The pick flows (judge wizard, evaluate-traces) keep auto-loading. */}
            <TraceBrowser sources={roster?.sources ?? []} autoLoad={false} />
          </div>
        </>
      )}
    </div>
  )
}
