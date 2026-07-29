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

// Settings › Agent › Tools — 이 에이전트가 지금 쓸 수 있는 도구 목록과 내 on/off.
// 워크스페이스 도구 + 나만 쓰는 도구 + 기본 제공이 한 목록이고, 토글은 "나"에게만 적용된다(사용자 결정).
// 발행/카탈로그/채택 같은 스토어 크롬은 여기 없다 — 그건 스토어의 일.
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
