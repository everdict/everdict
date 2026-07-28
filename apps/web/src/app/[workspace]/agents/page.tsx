import { getTranslations } from 'next-intl/server'

import { AgentFleet } from '@/features/agent-fleet'
import { agentRunListSchema, type AgentSession } from '@/entities/agent-session'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'
import { Callout } from '@/shared/ui/callout'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Agents fleet (docs/architecture/agent-automation.md A5) — the workspace's agent RUNS, live: what woke each
// agent, what it is doing, how it settled. The client island polls for status and offers stop/transcript.
export default async function AgentsPage() {
  const t = await getTranslations('agentFleet')
  const { principal, ctx } = await currentPrincipal()
  let runs: AgentSession[] = []
  let error: string | undefined
  try {
    runs = agentRunListSchema.parse(await agentPlane.listRuns(ctx)).runs
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const canStop = can(principal?.roles ?? [], 'agents:write')

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      {error ? <Callout tone="warning">{t('unavailable')}</Callout> : null}
      <AgentFleet initialRuns={runs} canStop={canStop} />
    </div>
  )
}
