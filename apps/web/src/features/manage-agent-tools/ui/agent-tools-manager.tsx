'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { AgentToolEntry, AgentToolScope } from '@/entities/agent-tool'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { setAgentToolAction } from '../api/set-agent-tool'

// Settings › Agent › Tools — 이 워크스페이스의 어시스턴트가 쓸 수 있는 도구 목록 + 내 on/off.
// 발행·카탈로그·채택 같은 스토어 크롬은 여기 없다(사용자 결정): 사용 가능한 도구를 나열하고 켜고 끄는 화면.
// 토글은 "나"에게만 적용된다 — 워크스페이스 기본값(AgentSpec)은 그대로이고, 같은 워크스페이스의 두 멤버가
// 서로 다른 도구셋으로 에이전트를 쓴다.

const SCOPE_ORDER: AgentToolScope[] = ['personal', 'workspace', 'builtin']

export function AgentToolsManager({ tools }: { tools: AgentToolEntry[] }) {
  const t = useTranslations('agentTools')
  // 상세는 라우트다(다이얼로그 아님) — 우측 대화 패널에서 이 도구를 두고 실험/편집해야 하므로.
  const workspace = String(useParams().workspace ?? '')
  const [state, setState] = useState(tools)
  const [pendingKey, setPendingKey] = useState<string | undefined>(undefined)
  const [, startTransition] = useTransition()

  const sections = useMemo(
    () =>
      SCOPE_ORDER.map((scope) => ({ scope, items: state.filter((tool) => tool.scope === scope) })),
    [state]
  )

  // 낙관적 반영 후 서버 액션 — 실패하면 이전 목록으로 되돌리고 사유를 알린다.
  const apply = (tool: AgentToolEntry, enabled: boolean | null) => {
    const previous = state
    const next = enabled === null ? tool.baseline : enabled
    setState((rows) => rows.map((row) => (row.key === tool.key ? { ...row, enabled: next } : row)))
    setPendingKey(tool.key)
    startTransition(async () => {
      const result = await setAgentToolAction(tool.key, enabled)
      setPendingKey(undefined)
      if (!result.ok) {
        setState(previous)
        toast.error(result.error ?? t('saveFailed'))
      }
    })
  }

  if (state.length === 0) return <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />

  return (
    <div className="space-y-6">
      {sections.map(({ scope, items }) =>
        items.length === 0 ? null : (
          <section key={scope} className="space-y-2">
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-medium">{t(`scope_${scope}`)}</h2>
              <InfoTip content={t(`scopeHint_${scope}`)} />
            </div>
            <SettingsList>
              {items.map((tool) => (
                <ToolRow
                  key={tool.key}
                  tool={tool}
                  href={`/${workspace}/tools/${encodeURIComponent(tool.key)}`}
                  pending={pendingKey === tool.key}
                  onToggle={(enabled) => apply(tool, enabled)}
                  onReset={() => apply(tool, null)}
                />
              ))}
            </SettingsList>
          </section>
        )
      )}
    </div>
  )
}

function ToolRow({
  tool,
  href,
  pending,
  onToggle,
  onReset,
}: {
  tool: AgentToolEntry
  href: string
  pending: boolean
  onToggle: (enabled: boolean) => void
  onReset: () => void
}) {
  const t = useTranslations('agentTools')
  const overridden = tool.enabled !== tool.baseline
  const shadowed = tool.shadowedBy !== undefined && tool.enabled === false
  return (
    <SettingsRow
      label={
        // 이름이 상세로 가는 링크 — 행의 오른쪽은 토글이 차지하므로, 드릴인은 이름 자체가 맡는다.
        <Link href={href} className="group flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[13px] underline-offset-2 group-hover:underline">
            {tool.name}
          </span>
          <ChevronRight
            className="size-3.5 text-faint opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          />
          <Badge tone="outline">{t(`type_${tool.type}`)}</Badge>
          {tool.writes && <Badge tone="warning">{t('writes')}</Badge>}
          {tool.missingSecrets.length > 0 && (
            <Badge tone="danger">
              {t('missingSecrets', { names: tool.missingSecrets.join(', ') })}
            </Badge>
          )}
          {overridden && <Badge tone="info">{t('overridden')}</Badge>}
        </Link>
      }
      hint={
        <>
          <span className="block">{tool.description}</span>
          {shadowed && <span className="block text-[11.5px]">{t('shadowed')}</span>}
        </>
      }
    >
      {overridden && (
        <button
          type="button"
          onClick={onReset}
          disabled={pending}
          className="text-[12px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
        >
          {t('followWorkspace')}
        </button>
      )}
      <input
        type="checkbox"
        className={cn('accent-primary', pending && 'opacity-50')}
        checked={tool.enabled}
        disabled={pending}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={tool.name}
      />
    </SettingsRow>
  )
}
