'use client'

import { useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { AgentToolEntry, AgentToolScope } from '@/entities/agent-tool'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { setAgentToolAction } from '../api/set-agent-tool'

// Settings › Agent › Tools — the list of tools this workspace's assistant can use, plus MY on/off.
// The store chrome (publishing, the catalog, adoption) is deliberately absent (a user decision): this screen lists the available tools and turns them on and off.
// A toggle applies to ME alone — the workspace default (AgentSpec) is untouched, and two members of the same workspace use the agent with
// different toolsets.

const SCOPE_ORDER: AgentToolScope[] = ['personal', 'workspace', 'builtin']

export function AgentToolsManager({ tools }: { tools: AgentToolEntry[] }) {
  const t = useTranslations('agentTools')
  // The detail is a ROUTE (not a dialog) — you have to experiment on and edit this tool with the conversation panel on the right.
  const workspace = String(useParams().workspace ?? '')
  const [state, setState] = useState(tools)
  const [pendingKey, setPendingKey] = useState<string | undefined>(undefined)
  const [, set_pending] = useState(false)

  const sections = useMemo(
    () =>
      SCOPE_ORDER.map((scope) => ({ scope, items: state.filter((tool) => tool.scope === scope) })),
    [state]
  )

  // Applied optimistically, then the server action — on failure it rolls back to the previous list and states the reason.
  const apply = (tool: AgentToolEntry, enabled: boolean | null) => {
    const previous = state
    const next = enabled === null ? tool.baseline : enabled
    setState((rows) => rows.map((row) => (row.key === tool.key ? { ...row, enabled: next } : row)))
    setPendingKey(tool.key)
    void (async () => {
      set_pending(true)
      try {
        const result = await setAgentToolAction(tool.key, enabled)
        setPendingKey(undefined)
        if (!result.ok) {
          setState(previous)
          toast.error(result.error ?? t('saveFailed'))
        }
      } finally {
        set_pending(false)
      }
    })()
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
                  href={`/${workspace}/tool/${encodeURIComponent(tool.key)}`}
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
        // The NAME is the link to the detail — the right of the row is taken by the toggle, so the name itself carries the drill-in.
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
