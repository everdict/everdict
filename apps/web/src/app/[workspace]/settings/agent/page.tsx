import { getTranslations } from 'next-intl/server'

import {
  agentSpecSchema,
  agentsSchema,
  type AgentSpec,
  type AgentSummary,
} from '@/entities/agent-spec'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

export const dynamic = 'force-dynamic'

// The stable id the default conversational agent is registered under — a mirror of the agent server's AGENT_CONFIG_ID.
const AGENT_CONFIG_ID = 'default'

// Settings › Agent — the workspace's agent list: the default conversational agent (default) at the top, plus additionally registered agents and
// first-party templates (_shared). A row click → the detail (/settings/agent/[id]). Making a new agent goes to the crafting studio.
export default async function AgentListSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const a = await getTranslations('agentSettings')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'agents:read')
  const header = (
    <PageHeader
      title={t('agent')}
      description={a('listDescription')}
      actions={
        <Link href={`/${workspace}/agents/craft`} className={buttonVariants({ size: 'sm' })}>
          {a('craftNew')}
        </Link>
      }
    />
  )
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  // The list plus each agent's latest spec (for the enabled/description/trigger badges). The entries are few, so parallel individual reads are enough.
  let entries: AgentSummary[] = []
  try {
    entries = agentsSchema.parse(await controlPlane.listAgents(ctx))
  } catch {
    entries = []
  }
  const specs = new Map<string, AgentSpec>()
  await Promise.all(
    entries.map(async (entry) => {
      try {
        specs.set(
          entry.id,
          agentSpecSchema.parse(await controlPlane.getAgent(ctx, entry.id, 'latest'))
        )
      } catch {
        // A row whose read failed shows the summary alone
      }
    })
  )

  // Order: default → workspace-owned → _shared templates. `default` is surfaced as a virtual row even when unregistered.
  const hasDefault = entries.some((e) => e.id === AGENT_CONFIG_ID)
  const rows = [
    ...(hasDefault
      ? []
      : [{ id: AGENT_CONFIG_ID, versions: [], owner: workspace } as AgentSummary]),
    ...entries,
  ].sort((x, y) => {
    const rank = (e: AgentSummary) => (e.id === AGENT_CONFIG_ID ? 0 : e.owner === '_shared' ? 2 : 1)
    return rank(x) - rank(y) || x.id.localeCompare(y.id)
  })

  return (
    <div className="space-y-6">
      {header}
      <SettingsList>
        {rows.map((entry) => {
          const spec = specs.get(entry.id)
          const isDefault = entry.id === AGENT_CONFIG_ID
          const isTemplate = entry.owner === '_shared'
          const triggerKinds = spec?.triggers.flatMap((tr) => tr.kinds) ?? []
          return (
            <SettingsRow
              key={`${entry.owner}:${entry.id}`}
              label={
                <span className="flex items-center gap-2">
                  <Link
                    href={`/${workspace}/settings/agent/${encodeURIComponent(entry.id)}`}
                    className="hover:underline"
                  >
                    {entry.id}
                  </Link>
                  {isDefault ? <Badge tone="info">{a('defaultBadge')}</Badge> : null}
                  {isTemplate ? <Badge tone="outline">{a('templateBadge')}</Badge> : null}
                  {spec?.enabled ? <Badge tone="success">{a('enabled')}</Badge> : null}
                </span>
              }
              hint={
                spec?.description ??
                (isDefault
                  ? a('defaultHint')
                  : triggerKinds.length > 0
                    ? a('triggerHint', { kinds: triggerKinds.slice(0, 3).join(', ') })
                    : a('manualHint'))
              }
            >
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {triggerKinds.length > 0 ? (
                  <Badge tone="outline">{a('triggerCount', { count: triggerKinds.length })}</Badge>
                ) : null}
                {entry.versions[0] ? (
                  <span>v{entry.versions[0]}</span>
                ) : (
                  <span>{a('unsaved')}</span>
                )}
                <Link
                  href={`/${workspace}/settings/agent/${encodeURIComponent(entry.id)}`}
                  className="text-primary hover:underline"
                >
                  {a('open')}
                </Link>
              </span>
            </SettingsRow>
          )
        })}
      </SettingsList>
    </div>
  )
}
