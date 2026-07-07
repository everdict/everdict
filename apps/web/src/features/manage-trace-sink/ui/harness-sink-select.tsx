'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'

import { assignHarnessTraceSinkAction } from '../api/manage-trace-sink'

// Per-harness trace sink selection — choose which observability platform this harness's scorecard detail results
// (per-case trace+scores) are exported to. '' = no export (clear the assignment → sink: null).
// authZ (harnesses:register = member+) is enforced by the control plane — canAssign is just a UI gate.
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

  // Read-only (viewer, etc.) — show only the current selection as text instead of the select control.
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
        setValue(previous) // revert to the previous selection on failure (the server is the source of truth).
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
