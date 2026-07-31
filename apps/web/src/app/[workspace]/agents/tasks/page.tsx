import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { TaskBoard } from '@/features/task-ledger'
import { agentTaskListSchema, type AgentTask } from '@/entities/agent-task'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// The workspace task ledger (docs/architecture/agent-teams.md) — the durable half of team coordination: the
// fleet page shows agent RUNS (activity), this board shows the WORK (units members and agents create, claim,
// chain and complete; task.created/completed wake subscribed teammate agents).
export default async function AgentTasksPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const t = await getTranslations('agentTasks')
  const { principal } = await currentPrincipal()
  const ctx = await authContext()
  let tasks: AgentTask[] = []
  let error: string | undefined
  try {
    tasks = agentTaskListSchema.parse(await controlPlane.listTasks(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const canWrite = can(principal?.roles ?? [], 'agents:write')

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Link
            href={`/${workspace}/agents`}
            className={buttonVariants({ size: 'sm', variant: 'outline' })}
          >
            {t('backToFleet')}
          </Link>
        }
      />
      {error ? <Callout tone="warning">{t('unavailable')}</Callout> : null}
      <TaskBoard initialTasks={tasks} canWrite={canWrite} />
    </div>
  )
}
