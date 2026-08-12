'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'

import { setAgentModelAction } from '../api/set-agent-model'

// "워크스페이스 기본값"을 고르는 값 — 빈 문자열은 콤보박스에서 "값 없음"과 구분되지 않아 센티넬을 쓴다.
const FOLLOW_WORKSPACE = '__workspace__'

// 내 대화가 기본으로 쓰는 모델. 즉시 적용되는 discrete 컨트롤(설정 UI 규약)이라 저장 버튼이 없고, 낙관적으로 로컬
// 상태를 먼저 옮긴 뒤 실패하면 되돌리고 토스트로 알린다.
// 첫 항목은 항상 "워크스페이스 기본값"이고, 기준선이 있으면 그 모델 id 를 힌트로 달아 준다 — 무엇을 따르는지 모르면
// 기본값을 고르는 선택이 되지 않는다.
export function AgentModelPicker({
  model,
  workspaceDefault,
  models,
}: {
  model: string | null
  workspaceDefault: string | null
  models: string[]
}) {
  const t = useTranslations('agentModelPreference')
  const [current, set_current] = useState<string | null>(model)
  const [pending, set_pending] = useState(false)

  const options = useMemo<ComboboxOption[]>(
    () => [
      {
        value: FOLLOW_WORKSPACE,
        label: t('followWorkspace'),
        hint: workspaceDefault ?? t('serverDefault'),
      },
      ...models.map((id) => ({ value: id })),
    ],
    [models, workspaceDefault, t]
  )

  function choose(next: string) {
    const picked = next === FOLLOW_WORKSPACE ? null : next
    if (picked === current) return
    const previous = current
    set_current(picked)
    void (async () => {
      set_pending(true)
      const result = await setAgentModelAction(picked)
      set_pending(false)
      if (!result.ok) {
        set_current(previous)
        toast.error(result.error ?? t('saveFailed'))
      }
    })()
  }

  return (
    <Combobox
      options={options}
      value={current ?? FOLLOW_WORKSPACE}
      onChange={choose}
      disabled={pending}
      align="end"
      className="min-w-[220px]"
      aria-label={t('label')}
      emptyText={t('noModels')}
    />
  )
}
