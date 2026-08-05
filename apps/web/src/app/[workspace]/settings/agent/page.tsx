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

// 기본 대화 에이전트가 등록되는 안정 id — agent 서버의 AGENT_CONFIG_ID 미러.
const AGENT_CONFIG_ID = 'default'

// Settings › Agent — 워크스페이스의 에이전트 목록: 기본 대화 에이전트(default) 최상단 + 추가 등록 에이전트 +
// first-party 템플릿(_shared). 행 클릭 → 상세(/settings/agent/[id]). 새 에이전트 제작은 크래프팅 스튜디오로.
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

  // 목록 + 각 에이전트의 latest 스펙(enabled/설명/트리거 배지용). 항목 수가 적어 병렬 개별 조회로 충분.
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
        // 조회 실패 행은 요약만 보여준다
      }
    })
  )

  // 정렬: 기본(default) → 워크스페이스 소유 → _shared 템플릿. default 는 미등록이어도 가상 행으로 노출.
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
