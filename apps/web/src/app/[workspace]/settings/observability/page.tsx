import { getTranslations } from 'next-intl/server'

import { TraceBrowser } from '@/features/browse-traces'
import { traceSourcesResponseSchema, type TraceSourcesResponse } from '@/entities/trace-source'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace observability — browse the traces + metrics a registered trace platform (MLflow/OTel/Langfuse/…) holds,
// like the platform's own UI. The same list is the judge wizard's sample-trace picker. Read = harnesses:read (viewer+).
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

  let roster: TraceSourcesResponse | undefined
  let error: string | undefined
  try {
    roster = traceSourcesResponseSchema.parse(await controlPlane.listTraceSources(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{error}</Callout>
      ) : (
        <TraceBrowser sources={roster?.sources ?? []} />
      )}
    </div>
  )
}
