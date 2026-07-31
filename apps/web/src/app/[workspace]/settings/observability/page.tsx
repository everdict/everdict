import { getTranslations } from 'next-intl/server'

import { ObservabilityTraceBrowser } from '@/widgets/infra-panel'
import { TrajectoryBrowser } from '@/features/browse-traces'
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
      {/* The PRIMARY section reads OUR store (native-observability N1 "look inward"): every sealed trajectory —
          own executions, OTLP-door arrivals, materialized imports — each row opening the evidence itself in a
          dialog (only source "run" also has a run page to link out to). The external platforms below stay as
          the pull/export integration surface. */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">{t('ownStoreTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('ownStoreDescription')}</p>
        <TrajectoryBrowser />
      </section>
      {error !== undefined ? (
        <Callout tone="danger">{error}</Callout>
      ) : (
        <div className="space-y-8 border-t pt-6">
          <TraceSourceManager
            sources={roster?.sources ?? []}
            canWrite={canWrite}
            secretNames={secretNames}
          />
          {/* No sources → no browser section at all (hide-empty-sections): the manager's empty line already says it,
              and a second "no sources" EmptyState below would just repeat it. */}
          {(roster?.sources.length ?? 0) > 0 && (
            <div className="border-t pt-6">
              {/* Opt out of auto-pull here: registering/listing a source shouldn't fire a slow platform query — the user
                  selects a source and presses Fetch. Each trace's detail dialog can hand it to the agent chat as context
                  ("analyze in chat"). The pick flows (judge wizard, evaluate-traces) keep auto-loading, no mention. */}
              <ObservabilityTraceBrowser sources={roster?.sources ?? []} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
