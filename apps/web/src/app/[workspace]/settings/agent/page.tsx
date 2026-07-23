import { getTranslations } from 'next-intl/server'

import { type AgentSpec, agentSpecSchema } from '@/entities/agent-spec'
import { modelsSchema } from '@/entities/model'
import { secretsSchema } from '@/entities/secret'
import { AgentManager } from '@/features/manage-agent'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// The stable id under which a workspace registers its (single, default) agent configuration — mirrors the agent
// server's AGENT_CONFIG_ID. Multiple named agents + per-conversation selection is a later channel.
const AGENT_CONFIG_ID = 'default'

// Workspace › Agent — customize the workspace's conversational agent (instructions + MCP tool servers + model),
// plugging its own context + tools into the shared agent framework. agents:read to view; agents:write to save.
export default async function AgentSettingsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'agents:read')
  const canWrite = can(principal?.roles, 'agents:write')
  const header = <PageHeader title={t('agent')} description={t('agentDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  // The workspace's default agent (latest version); an unregistered id 404s → an empty form.
  let agent: AgentSpec | undefined
  try {
    agent = agentSpecSchema.parse(await controlPlane.getAgent(ctx, AGENT_CONFIG_ID, 'latest'))
  } catch {
    // Not registered yet — start from a blank customization.
  }

  // Registered model ids power the model-override picker; workspace secret names power each MCP server's authSecret picker.
  let modelIds: string[] = []
  try {
    modelIds = modelsSchema.parse(await controlPlane.listModels(ctx)).map((m) => m.id)
  } catch {
    // No model registry / no permission — the picker just offers "server default".
  }

  let secretNames: string[] = []
  try {
    secretNames = secretsSchema
      .parse(await controlPlane.listSecrets(ctx))
      .filter((secret) => secret.scope === 'workspace')
      .map((secret) => secret.name)
  } catch {
    // Secrets are admin-read — a non-admin member sees no existing names (they can still type a known one).
  }

  return (
    <div className="space-y-6">
      {header}
      <AgentManager
        {...(agent ? { agent } : {})}
        secretNames={secretNames}
        modelIds={modelIds}
        canWrite={canWrite}
        configId={AGENT_CONFIG_ID}
      />
    </div>
  )
}
