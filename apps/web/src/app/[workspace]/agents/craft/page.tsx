import { getTranslations } from 'next-intl/server'

import { AgentChatOpener } from '@/widgets/infra-panel'
import { AgentCraftStudio } from '@/features/craft-agent'
import { agentSpecSchema, type AgentSpec } from '@/entities/agent-spec'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// The agent crafting studio (agent-automation B2/B3) — the canvas on the left (the agent being made) plus the chat panel on the right.
// The same entry contract as analysis-studio: the conversation opens on arrival (AgentChatOpener), and the natural-language route IS the making route.
// ?agent=<id> puts an existing registered agent on the canvas to edit.
export default async function AgentCraftPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>
}) {
  const { agent } = await searchParams
  const t = await getTranslations('craftAgent')
  let initialSpec: AgentSpec | null = null
  if (agent) {
    try {
      const ctx = await authContext()
      initialSpec = agentSpecSchema.parse(await controlPlane.getAgent(ctx, agent, 'latest'))
    } catch {
      initialSpec = null // an unregistered id — start fresh from an empty canvas
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <div className="max-w-3xl">
        <AgentCraftStudio {...(agent ? { agentId: agent } : {})} initialSpec={initialSpec} />
      </div>
      <AgentChatOpener prompt={t('kickoffPrompt')} mission="agentCraft" />
    </div>
  )
}
