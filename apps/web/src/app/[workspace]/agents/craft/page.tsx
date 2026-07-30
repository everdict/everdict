import { getTranslations } from 'next-intl/server'

import { AgentChatOpener } from '@/widgets/infra-panel'
import { AgentCraftStudio } from '@/features/craft-agent'
import { agentSpecSchema, type AgentSpec } from '@/entities/agent-spec'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 에이전트 크래프팅 스튜디오(agent-automation B2/B3) — 왼쪽 캔버스(만들어지는 에이전트) + 오른쪽 챗 패널.
// analysis-studio 와 같은 진입 계약: 도착 즉시 대화가 열리고(AgentChatOpener), 자연어 경로가 곧 제작 경로다.
// ?agent=<id> 는 기존 등록 에이전트를 캔버스에 올려 편집한다.
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
      initialSpec = null // 미등록 id — 빈 캔버스에서 새로 시작
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
