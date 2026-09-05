import { getTranslations } from 'next-intl/server'

import { AgentToolsManager } from '@/features/manage-agent-tools'
import { agentToolListSchema, type AgentToolEntry } from '@/entities/agent-tool'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Agent › Tools — the tools this agent can use right now, plus MY on/off.
// Workspace tools, tools only I use, and the built-in defaults are ONE list, and a toggle applies to "me" alone (a user decision).
// The store chrome (publishing, the catalog, adoption) is not here — that is the store's business.
export default async function AgentToolsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const header = <PageHeader title={t('tools')} description={t('toolsDesc')} />
  if (!can(principal?.roles, 'capabilities:read')) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let tools: AgentToolEntry[] = []
  let error: string | undefined
  try {
    tools = agentToolListSchema.parse(await controlPlane.listAgentTools(ctx)).tools
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <AgentToolsManager tools={tools} />
      )}
    </div>
  )
}
