'use client'

import { useState } from 'react'
import { Check, Copy, Power } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { AgentSpec } from '@/entities/agent-spec'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { saveAgentAction } from '../api/manage-agent'

// 등록 에이전트 상세의 액션 아일랜드 — 활성 토글(상태 컨트롤=아이콘+드롭다운 관례) · 템플릿 채택.
// 저장은 기존 PUT /agents 업서트(saveAgentAction): 스펙 전체를 body 로 보내되 enabled 만 바꾼다.
// 템플릿(_shared) 채택 = 같은 body 를 내 워크스페이스로 저장 → 사본에 creator 가 찍혀 활성화가 의미를 갖는다.
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
