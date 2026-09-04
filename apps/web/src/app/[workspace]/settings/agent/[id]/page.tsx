import { getTranslations } from 'next-intl/server'

import { AgentDetailActions, AgentManager } from '@/features/manage-agent'
import {
  agentDefaultsSchema,
  agentSpecSchema,
  agentsSchema,
  type AgentDefault,
  type AgentSpec,
  type AgentSummary,
} from '@/entities/agent-spec'
import { modelsSchema } from '@/entities/model'
import { secretsSchema } from '@/entities/secret'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

const AGENT_CONFIG_ID = 'default'

// Settings › Agent › detail — `default` (the main conversational agent) keeps the existing editor (AgentManager), and every other registered
// agent or template gets a spec READ view plus actions (the enabled toggle · adopt as template · open in craft). Empty sections hide (the convention).
export default async function AgentDetailSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const a = await getTranslations('agentSettings')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'agents:read')
  const canWrite = can(principal?.roles, 'agents:write')
  if (!canRead) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('agent')} description={a('listDescription')} />
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  // The main conversational agent — the existing customization editor unchanged (instructions/MCP/model/default-tool toggles).
  if (id === AGENT_CONFIG_ID) {
    let agent: AgentSpec | undefined
    try {
      agent = agentSpecSchema.parse(await controlPlane.getAgent(ctx, AGENT_CONFIG_ID, 'latest'))
    } catch {
      // Not registered — start from an empty customization form.
    }
    let modelIds: string[] = []
    try {
      modelIds = modelsSchema.parse(await controlPlane.listModels(ctx)).map((m) => m.id)
    } catch {
      // No model registry — the picker offers only "the server default".
    }
    let defaults: AgentDefault[] = []
    try {
      defaults = agentDefaultsSchema.parse(await controlPlane.listAgentDefaults(ctx)).defaults
    } catch {
      // No default-tool list — the toggle section hides.
    }
    let secretNames: string[] = []
    try {
      secretNames = secretsSchema
        .parse(await controlPlane.listSecrets(ctx))
        .filter((secret) => secret.scope === 'workspace')
        .map((secret) => secret.name)
    } catch {
      // Secrets are admin-read — a non-admin types the name directly, with no name list.
    }
    return (
      <div className="space-y-6">
        <PageHeader
          title={`${t('agent')} · ${AGENT_CONFIG_ID}`}
          description={a('defaultHint')}
          actions={<BackToList workspace={workspace} label={a('backToList')} />}
        />
        <AgentManager
          {...(agent ? { agent } : {})}
          secretNames={secretNames}
          modelIds={modelIds}
          defaults={defaults}
          canWrite={canWrite}
          configId={AGENT_CONFIG_ID}
        />
      </div>
    )
  }

  // A registered agent or template detail — the latest spec plus ownership information (owner, versions).
  let spec: AgentSpec | null = null
  try {
    spec = agentSpecSchema.parse(await controlPlane.getAgent(ctx, id, 'latest'))
  } catch {
    spec = null
  }
  let entry: AgentSummary | undefined
  try {
    entry = agentsSchema.parse(await controlPlane.listAgents(ctx)).find((e) => e.id === id)
  } catch {
    entry = undefined
  }
  if (!spec) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={`${t('agent')} · ${id}`}
          actions={<BackToList workspace={workspace} label={a('backToList')} />}
        />
        <EmptyState title={a('notFoundTitle')} hint={a('notFoundHint')} />
      </div>
    )
  }
  const isTemplate = entry?.owner === '_shared'
  const triggerKinds = spec.triggers.flatMap((tr) => tr.kinds)

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${t('agent')} · ${id}`}
        {...(spec.description ? { description: spec.description } : {})}
        actions={<BackToList workspace={workspace} label={a('backToList')} />}
      />

      {/* The meta strip — state, version, mode, model and ownership on one line (empty values omitted) */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {spec.enabled ? (
          <Badge tone="success">{a('enabled')}</Badge>
        ) : (
          <Badge>{a('disabled')}</Badge>
        )}
        {isTemplate ? <Badge tone="outline">{a('templateBadge')}</Badge> : null}
        <Badge tone="outline">v{spec.version}</Badge>
        {spec.permissionMode ? <Badge tone="info">{spec.permissionMode}</Badge> : null}
        {spec.model ? <Badge tone="outline">{spec.model}</Badge> : null}
        {entry && entry.versions.length > 1 ? (
          <span className="text-xs text-muted-foreground">
            {a('versionCount', { count: entry.versions.length })}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/${workspace}/agents/craft?agent=${encodeURIComponent(id)}`}
          className={buttonVariants({ size: 'sm', variant: 'outline' })}
        >
          {a('openInCraft')}
        </Link>
        <AgentDetailActions id={id} spec={spec} isTemplate={isTemplate} canWrite={canWrite} />
      </div>

      {triggerKinds.length > 0 ? (
        <Section title={a('triggers')}>
          <div className="space-y-1.5">
            {spec.triggers.map((trigger, i) => (
              <div
                key={`${trigger.kinds.join(',')}-${i}`}
                className="flex flex-wrap items-center gap-1.5 text-xs"
              >
                {trigger.kinds.map((kind) => (
                  <Badge key={kind} tone="info">
                    {kind}
                  </Badge>
                ))}
                {trigger.filters.map((f) => (
                  <code
                    key={`${f.field}${f.op}`}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono"
                  >
                    {f.field} {f.op} {f.value === undefined ? '' : String(f.value)}
                  </code>
                ))}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {spec.task ? (
        <Section title={a('task')}>
          <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-xs">
            {spec.task}
          </pre>
        </Section>
      ) : null}

      {spec.instructions ? (
        <Section title={a('instructions')}>
          <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-xs">
            {spec.instructions}
          </pre>
        </Section>
      ) : null}

      {spec.mcpServers.length > 0 || spec.capabilities.length > 0 ? (
        <Section title={a('tools')}>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {spec.mcpServers.map((server) => (
              <Badge key={server.name} tone="outline">
                mcp · {server.name}
                {server.write ? ' (write)' : ''}
              </Badge>
            ))}
            {spec.capabilities.map((cap) => (
              <Badge key={`${cap.source}:${cap.id}`} tone="outline">
                {cap.id}@{cap.version}
              </Badge>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  )
}

function BackToList({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/settings/agent`}
      className={buttonVariants({ size: 'sm', variant: 'ghost' })}
    >
      {label}
    </Link>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="space-y-2 p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </Card>
  )
}
