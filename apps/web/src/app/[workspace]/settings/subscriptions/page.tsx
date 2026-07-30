import { getTranslations } from 'next-intl/server'

import { agentsSchema } from '@/entities/agent-spec'
import { subscriptionsSchema, type Subscription } from '@/entities/subscription'
import { SubscriptionsManager } from '@/features/manage-subscriptions'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Agent › Subscriptions — the E3 registry: event → reaction rules under governance. One
// mechanism for every reaction kind (wake an agent · signed webhook · durable multi-step chain); the
// agent's own spec triggers remain a second, older source until their relocation lands.
export default async function SubscriptionsPage() {
  const t = await getTranslations('subscriptions')
  const { principal } = await currentPrincipal()
  const ctx = await authContext()

  let subscriptions: Subscription[] = []
  let agentIds: string[] = []
  try {
    subscriptions = subscriptionsSchema.parse(await controlPlane.listSubscriptions(ctx))
  } catch {
    // Subscriptions may not be configured on this control plane — render empty; a create attempt surfaces it.
  }
  try {
    agentIds = agentsSchema.parse(await controlPlane.listAgents(ctx)).map((agent) => agent.id)
  } catch {
    // No agent registry — the agent/workflow reaction pickers just render empty.
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <SubscriptionsManager
        initialSubscriptions={subscriptions}
        agentIds={agentIds}
        canWrite={can(principal?.roles, 'agents:write')}
      />
    </div>
  )
}
