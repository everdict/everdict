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

// Settings › Agent › 상세 — default(기본 대화 에이전트)는 기존 편집기(AgentManager) 그대로, 나머지 등록
// 에이전트/템플릿은 스펙 읽기 뷰 + 액션(활성 토글 · 템플릿 채택 · 크래프트에서 열기). 빈 섹션은 숨긴다(관례).
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

  // 기본 대화 에이전트 — 기존 커스터마이즈 편집기(instructions/MCP/모델/기본도구 토글) 그대로.
  if (id === AGENT_CONFIG_ID) {
    let agent: AgentSpec | undefined
    try {
      agent = agentSpecSchema.parse(await controlPlane.getAgent(ctx, AGENT_CONFIG_ID, 'latest'))
    } catch {
      // 미등록 — 빈 커스터마이즈 폼에서 시작.
    }
    let modelIds: string[] = []
    try {
      modelIds = modelsSchema.parse(await controlPlane.listModels(ctx)).map((m) => m.id)
    } catch {
      // 모델 레지스트리 없음 — 피커는 "서버 기본"만 제공.
    }
    let defaults: AgentDefault[] = []
    try {
      defaults = agentDefaultsSchema.parse(await controlPlane.listAgentDefaults(ctx)).defaults
    } catch {
      // 기본도구 목록 없음 — 토글 섹션 숨김.
    }
    let secretNames: string[] = []
    try {
      secretNames = secretsSchema
        .parse(await controlPlane.listSecrets(ctx))
        .filter((secret) => secret.scope === 'workspace')
        .map((secret) => secret.name)
    } catch {
      // 시크릿은 admin-read — 비관리자는 이름 목록 없이 직접 입력.
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

  // 등록 에이전트/템플릿 상세 — latest 스펙 + 소유 정보(owner/버전들).
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

      {/* 메타 스트립 — 상태·버전·모드·모델·소유를 한 줄로 (빈 값은 생략) */}
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
