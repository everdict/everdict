'use client'

import { useState } from 'react'
import { Bot, Globe, Plus, Power, PowerOff, Trash2, Workflow } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { TRIGGERABLE_EVENT_KINDS } from '@/entities/agent-spec'
import { subscriptionSchema, type Subscription } from '@/entities/subscription'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'

// Settings › Agent › Subscriptions — the E3 registry as a settings list: each rule is
// selector (event kinds) → reaction (agent | webhook | workflow) under governance (enabled + cooldown).
// Lean by design: kinds + reaction are authored here; payload FILTERS are an authoring detail the MCP
// tools cover (a rule that carries them shows a filter count). Edit/delete = creator or admin, enforced
// by the control plane (this component only hides what a viewer can't do).

type ReactionKind = Subscription['reaction']['kind']

const REACTION_ICON: Record<ReactionKind, typeof Bot> = {
  agent: Bot,
  webhook: Globe,
  workflow: Workflow,
}

function reactionSummary(reaction: Subscription['reaction']): string {
  if (reaction.kind === 'agent') return reaction.agentId
  if (reaction.kind === 'webhook') {
    try {
      return new URL(reaction.url).host
    } catch {
      return reaction.url
    }
  }
  return reaction.steps.map((step) => step.agentId).join(' → ')
}

export function SubscriptionsManager({
  initialSubscriptions,
  agentIds,
  canWrite,
}: {
  initialSubscriptions: Subscription[]
  agentIds: string[]
  canWrite: boolean
}) {
  const t = useTranslations('subscriptions')
  const [rules, setRules] = useState<Subscription[]>(initialSubscriptions)
  const [creating, setCreating] = useState(false)
  const [confirming, setConfirming] = useState<Subscription | null>(null)
  const [error, setError] = useState<string | null>(null)

  const setEnabled = async (rule: Subscription, enabled: boolean) => {
    try {
      const res = await fetch(`/api/subscriptions/${encodeURIComponent(rule.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ governance: { ...rule.governance, enabled } }),
      })
      const json = (await res.json()) as { error?: string; message?: string }
      if (!res.ok || json.error) throw new Error(json.error ?? json.message ?? `HTTP ${res.status}`)
      const next = subscriptionSchema.parse(json)
      setRules((prev) => prev.map((r) => (r.id === rule.id ? next : r)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const remove = async (rule: Subscription) => {
    setConfirming(null)
    setRules((prev) => prev.filter((r) => r.id !== rule.id))
    try {
      const res = await fetch(`/api/subscriptions/${encodeURIComponent(rule.id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      setRules((prev) => [rule, ...prev]) // deletion refused (not the creator / not admin) — restore the row
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">{t('lede')}</p>
        {canWrite ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> {t('create')}
          </Button>
        ) : null}
      </div>

      {rules.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('emptyDescription')} />
      ) : (
        <div className="rounded-lg border bg-card shadow-raise">
          <ul className="divide-y divide-border/70">
            {rules.map((rule) => {
              const Icon = REACTION_ICON[rule.reaction.kind]
              const filterCount = rule.selector.filters.length
              return (
                <li key={rule.id} className="flex min-h-[60px] items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'truncate text-[13px] font-[560]',
                          rule.governance.enabled ? '' : 'text-muted-foreground',
                        )}
                      >
                        {rule.name}
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-[11px] text-muted-foreground">
                        <Icon className="size-3" />
                        {t(`reaction_${rule.reaction.kind}`)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[12px] text-muted-foreground">
                      {rule.selector.kinds.slice(0, 3).map((kind) => (
                        <code key={kind} className="rounded bg-muted px-1 py-px text-[11px]">
                          {kind}
                        </code>
                      ))}
                      {rule.selector.kinds.length > 3 ? (
                        <span>+{rule.selector.kinds.length - 3}</span>
                      ) : null}
                      {filterCount > 0 ? <span>· {t('filterCount', { count: filterCount })}</span> : null}
                      <span className="truncate">→ {reactionSummary(rule.reaction)}</span>
                    </div>
                  </div>
                  {canWrite ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <DropdownMenu
                        align="end"
                        trigger={({ toggle }) => (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={rule.governance.enabled ? t('enabled') : t('disabled')}
                            aria-label={rule.governance.enabled ? t('enabled') : t('disabled')}
                            onClick={toggle}
                          >
                            {rule.governance.enabled ? (
                              <Power className="text-[var(--color-success,theme(colors.emerald.500))]" />
                            ) : (
                              <PowerOff className="text-muted-foreground" />
                            )}
                          </Button>
                        )}
                      >
                        {rule.governance.enabled ? (
                          <DropdownItem icon={<PowerOff className="size-4" />} onSelect={() => void setEnabled(rule, false)}>
                            {t('disable')}
                          </DropdownItem>
                        ) : (
                          <DropdownItem icon={<Power className="size-4" />} onSelect={() => void setEnabled(rule, true)}>
                            {t('enable')}
                          </DropdownItem>
                        )}
                      </DropdownMenu>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t('delete')}
                        aria-label={t('delete')}
                        onClick={() => setConfirming(rule)}
                      >
                        <Trash2 className="text-muted-foreground" />
                      </Button>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {creating ? (
        <CreateSubscriptionDialog
          agentIds={agentIds}
          onClose={() => setCreating(false)}
          onCreated={(rule) => {
            setRules((prev) => [rule, ...prev])
            setCreating(false)
          }}
        />
      ) : null}

      <Dialog open={confirming !== null} onClose={() => setConfirming(null)} className="max-w-sm">
        {confirming && (
          <div className="space-y-3 p-4">
            <h3 className="text-[13.5px] font-medium">{t('deleteTitle')}</h3>
            <p className="text-[12.5px] text-muted-foreground">{t('deleteBody', { name: confirming.name })}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                {t('cancel')}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void remove(confirming)}>
                {t('delete')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}

function CreateSubscriptionDialog({
  agentIds,
  onClose,
  onCreated,
}: {
  agentIds: string[]
  onClose: () => void
  onCreated: (rule: Subscription) => void
}) {
  const t = useTranslations('subscriptions')
  const [name, setName] = useState('')
  const [kinds, setKinds] = useState<string[]>([])
  const [reactionKind, setReactionKind] = useState<ReactionKind>('agent')
  const [agentId, setAgentId] = useState(agentIds[0] ?? '')
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [steps, setSteps] = useState<Array<{ agentId: string; instruction: string }>>([
    { agentId: agentIds[0] ?? '', instruction: '' },
  ])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleKind = (kind: string) =>
    setKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))

  const reaction = (): unknown => {
    if (reactionKind === 'agent') return { kind: 'agent', agentId }
    if (reactionKind === 'webhook')
      return { kind: 'webhook', url, ...(secret.trim().length > 0 ? { secret: secret.trim() } : {}) }
    return {
      kind: 'workflow',
      steps: steps
        .filter((step) => step.agentId)
        .map((step) => ({
          agentId: step.agentId,
          ...(step.instruction.trim().length > 0 ? { instruction: step.instruction.trim() } : {}),
        })),
    }
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), selector: { kinds, filters: [] }, reaction: reaction() }),
      })
      const json = (await res.json()) as { error?: string; message?: string }
      if (!res.ok || json.error) throw new Error(json.error ?? json.message ?? `HTTP ${res.status}`)
      onCreated(subscriptionSchema.parse(json))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const valid =
    name.trim().length > 0 &&
    kinds.length > 0 &&
    (reactionKind === 'agent'
      ? agentId.length > 0
      : reactionKind === 'webhook'
        ? url.startsWith('http')
        : steps.some((step) => step.agentId))

  const selectClass =
    'h-8 rounded-md border border-input bg-background px-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring'

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <div className="space-y-4 p-4">
        <h3 className="text-[13.5px] font-medium">{t('createTitle')}</h3>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <div className="space-y-1.5">
          <label className="text-[12px] font-[560] text-muted-foreground" htmlFor="sub-name">
            {t('nameLabel')}
          </label>
          <Input
            id="sub-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
            className="sm:w-72"
          />
        </div>

        <div className="space-y-1.5">
          <span className="text-[12px] font-[560] text-muted-foreground">{t('kindsLabel')}</span>
          <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto rounded-md border p-2">
            {TRIGGERABLE_EVENT_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                  kinds.includes(kind)
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/70',
                )}
              >
                {kind}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <span className="text-[12px] font-[560] text-muted-foreground">{t('reactionLabel')}</span>
          <div className="flex gap-1">
            {(['agent', 'webhook', 'workflow'] as const).map((kind) => {
              const Icon = REACTION_ICON[kind]
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setReactionKind(kind)}
                  className={cn(
                    'flex items-center gap-1 rounded-md border px-2 py-1 text-[12px]',
                    reactionKind === kind ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground',
                  )}
                >
                  <Icon className="size-3.5" /> {t(`reaction_${kind}`)}
                </button>
              )
            })}
          </div>
        </div>

        {reactionKind === 'agent' ? (
          <div className="space-y-1.5">
            <label className="text-[12px] font-[560] text-muted-foreground" htmlFor="sub-agent">
              {t('agentLabel')}
            </label>
            <div>
              <select id="sub-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className={selectClass}>
                {agentIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}

        {reactionKind === 'webhook' ? (
          <div className="space-y-2">
            <div className="space-y-1.5">
              <label className="text-[12px] font-[560] text-muted-foreground" htmlFor="sub-url">
                {t('urlLabel')}
              </label>
              <Input
                id="sub-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://hooks.example.com/everdict"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] font-[560] text-muted-foreground" htmlFor="sub-secret">
                {t('secretLabel')}
              </label>
              <Input
                id="sub-secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={t('secretPlaceholder')}
                className="sm:w-72"
              />
            </div>
          </div>
        ) : null}

        {reactionKind === 'workflow' ? (
          <div className="space-y-2">
            {steps.map((step, index) => (
              <div key={`step-${index.toString()}`} className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">#{index + 1}</span>
                <select
                  value={step.agentId}
                  onChange={(e) =>
                    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, agentId: e.target.value } : s)))
                  }
                  className={selectClass}
                  aria-label={t('agentLabel')}
                >
                  {agentIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <Input
                  value={step.instruction}
                  onChange={(e) =>
                    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, instruction: e.target.value } : s)))
                  }
                  placeholder={t('instructionPlaceholder')}
                  className="flex-1"
                />
                {steps.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('removeStep')}
                    onClick={() => setSteps((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            ))}
            {steps.length < 3 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSteps((prev) => [...prev, { agentId: agentIds[0] ?? '', instruction: '' }])}
              >
                <Plus /> {t('addStep')}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? t('creating') : t('create')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
