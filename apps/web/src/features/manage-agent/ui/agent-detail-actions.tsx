'use client'

import { useState } from 'react'
import { Check, Copy, Power } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { AgentSpec } from '@/entities/agent-spec'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { saveAgentAction } from '../api/manage-agent'

// The action island on a registered agent's detail — the enabled toggle (the status control convention: an icon plus a dropdown) · adopting a template.
// Saving uses the existing PUT /agents upsert (saveAgentAction): the whole spec goes in the body and only `enabled` changes.
// Adopting a template (_shared) = saving that same body into MY workspace → the copy carries a creator, which is what makes enabling it mean something.
function bodyFrom(spec: AgentSpec, enabled: boolean): Record<string, unknown> {
  const { id: _id, version: _version, ...rest } = spec
  return { ...rest, enabled }
}

export function AgentDetailActions({
  id,
  spec,
  isTemplate,
  canWrite,
}: {
  id: string
  spec: AgentSpec
  isTemplate: boolean
  canWrite: boolean
}) {
  const t = useTranslations('agentSettings')
  const refresh = useRefresh()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!canWrite) return null

  const apply = async (enabled: boolean) => {
    setBusy(true)
    setError(null)
    const r = await saveAgentAction(id, bodyFrom(spec, enabled))
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'failed')
    else refresh()
  }

  if (isTemplate) {
    return (
      <span className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void apply(spec.enabled)}>
          <Copy className="size-3.5" aria-hidden />
          {t('adopt')}
        </Button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </span>
    )
  }

  return (
    <span className="flex items-center gap-2">
      <DropdownMenu
        trigger={({ toggle }) => (
          <Button size="sm" variant="outline" disabled={busy} onClick={toggle}>
            <Power className="size-3.5" aria-hidden />
            {spec.enabled ? t('enabled') : t('disabled')}
          </Button>
        )}
      >
        <DropdownItem
          onSelect={() => void apply(true)}
          trailing={spec.enabled ? <Check className="size-3.5" aria-hidden /> : undefined}
        >
          {t('enable')}
        </DropdownItem>
        <DropdownItem
          onSelect={() => void apply(false)}
          trailing={!spec.enabled ? <Check className="size-3.5" aria-hidden /> : undefined}
        >
          {t('disable')}
        </DropdownItem>
      </DropdownMenu>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  )
}
