'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'

import { setAgentModelAction } from '../api/set-agent-model'

// The value that selects "the workspace default" — the empty string is indistinguishable from "no value" in a combobox, so a sentinel is used.
const FOLLOW_WORKSPACE = '__workspace__'

// The model my conversations use by default. It is a DISCRETE control applied immediately (the settings UI convention), so there is no save
// button: local state moves optimistically first and rolls back with a toast on failure.
// The first entry is always "the workspace default", and when there is a baseline its model id is attached as a hint — without knowing WHAT it
// follows, choosing the default is not a choice.
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
