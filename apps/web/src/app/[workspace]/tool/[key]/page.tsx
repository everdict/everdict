import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { MentionInChatButton } from '@/widgets/infra-panel'
import { ToolDetail } from '@/features/manage-agent-tools'
import { agentToolDetailSchema, type AgentToolDetail } from '@/entities/agent-tool'
import { secretsSchema } from '@/entities/secret'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Agent › Tools › detail — what sits behind the list's switch. How this tool is reached, what function it puts in front of the model
// and under what name, what description the model reads, and which secrets it needs. And whether it actually runs (a connection test
// · running an example). A detail is always a route and never a dialog — you have to experiment on and edit this tool with the conversation panel on the right.
//
// The main editing path is the same "edit by conversation" as the skill detail: it drops a reference chip and frames the panel with the toolEdit mission.
// The agent reads through get_capability and cuts a new version through save_capability (under HITL approval) — form-editing a tool spec is the store's business.
// Only a capability THIS workspace owns is editable (a built-in tool and somebody else's publication are read-only).
export default async function AgentToolDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key: raw } = await params
  const key = decodeURIComponent(raw)
  const t = await getTranslations('agentTools')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  if (!can(principal?.roles, 'capabilities:read')) {
    return <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
  }

  let tool: AgentToolDetail
  try {
    tool = agentToolDetailSchema.parse(await controlPlane.getAgentTool(ctx, key))
  } catch {
    notFound() // a key not in my toolset — a 404 that leaks no existence (the control plane judges)
  }

  // The binding picker's candidates — the workspace plus my personal secret NAMES (no values arrive).
  let secretNames: string[] = []
  try {
    secretNames = secretsSchema
      .parse(await controlPlane.listSecrets(ctx))
      .map((secret) => secret.name)
  } catch {
    // No secret store configured — the picker offers only creating a new one, with no existing names.
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/tools`}
        className="inline-flex items-center gap-1 text-[13px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {t('backToTools')}
      </Link>
      <PageHeader title={tool.name} description={tool.description} />
      <ToolDetail
        tool={tool}
        secretNames={secretNames}
        canBind={can(principal?.roles, 'agents:write')}
        actions={
          tool.editable && tool.capability ? (
            <MentionInChatButton
              reference={{
                type: 'tool',
                id: tool.capability.id,
                version: tool.capability.version,
                label: tool.name,
                source: tool.capability.source,
              }}
              label={t('editInChat')}
              mission="toolEdit"
            />
          ) : undefined
        }
      />
    </div>
  )
}
