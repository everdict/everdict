'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'

import { assignHarnessTraceSinkAction } from '../api/manage-trace-sink'

// 하니스별 트레이스 싱크 선택 — 이 하니스의 스코어카드 상세 결과(케이스별 trace+점수)를 어느 관측
// 플랫폼에 적재할지 고른다. '' = 적재 안 함(assignment 해제 → sink: null).
// authZ(harnesses:register=member+)는 컨트롤플레인이 강제 — canAssign 은 UI 게이트일 뿐.
export function HarnessSinkSelect({
  harnessId,
  sinks,
  current,
  canAssign,
}: {
  harnessId: string
  sinks: { name: string; kind: string }[]
  current?: string
  canAssign: boolean
}) {
  const t = useTranslations('manageTraceSink')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [value, setValue] = useState(current ?? '')

  // 읽기 전용(viewer 등) — 선택 컨트롤 대신 현재 선택만 텍스트로.
  if (!canAssign) {
    return <span className="text-[13px] text-muted-foreground">{current ?? t('notExported')}</span>
  }

  function onChange(next: string) {
    const previous = value
    setError(undefined)
    setValue(next)
    startTransition(async () => {
      const r = await assignHarnessTraceSinkAction(harnessId, next || null)
      if (!r.ok) {
        setError(r.error)
        setValue(previous) // 실패 시 이전 선택으로 되돌린다(서버가 진실원천).
      }
    })
  }

  return (
    <div className="w-full max-w-60 space-y-1.5">
      <Combobox
        options={[
          { value: '', label: t('notExported') },
          ...sinks.map((s) => ({ value: s.name, label: `${s.name} (${s.kind})` })),
        ]}
        value={value}
        onChange={onChange}
        disabled={pending}
        aria-label={t('sinkSelectLabel')}
      />
      {error && (
        <Callout tone="danger" className="py-1">
          {error}
        </Callout>
      )}
    </div>
  )
}
