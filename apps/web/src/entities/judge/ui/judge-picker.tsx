'use client'

import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { versionOptions } from '@/shared/lib/version-options'
import { Combobox } from '@/shared/ui/combobox'

// A judge reference as submitted to the control plane — id + version ('latest' or a concrete registered version).
export interface JudgeRef {
  id: string
  version: string
}

// What the picker offers — the judge list's id + versions (+ mutable version tags) slice.
export interface JudgePickerChoice {
  id: string
  versions: string[]
  versionTags?: Record<string, string[]>
}

// THE multi-judge selector (scorecard wizard · trace evaluation · schedule · re-run dialog): an add-combobox over the
// registered judges + one row per selected judge with its OWN version picker (added judges default to latest). A
// selected judge missing from the choices (deleted since, or the list fetch failed) still renders — its version
// combobox just offers latest, and the current value stays surfaced verbatim on the trigger.
export function JudgePicker({
  id,
  judges,
  value,
  onChange,
}: {
  id?: string
  judges: JudgePickerChoice[]
  value: JudgeRef[]
  onChange: (value: JudgeRef[]) => void
}) {
  const t = useTranslations('judgePicker')
  const selected = new Set(value.map((j) => j.id))
  const available = judges.filter((j) => !selected.has(j.id)).map((j) => ({ value: j.id }))

  return (
    <div className="space-y-2">
      <Combobox
        id={id}
        options={available}
        value=""
        onChange={(v) => {
          if (v && !selected.has(v)) onChange([...value, { id: v, version: 'latest' }])
        }}
        placeholder={t('placeholder')}
        emptyText={t('empty')}
      />
      {value.length > 0 && (
        <div className="space-y-1.5">
          {value.map((ref) => {
            const entry = judges.find((j) => j.id === ref.id)
            return (
              <div key={ref.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate rounded bg-secondary px-2 py-1 font-mono text-[12px] font-[510] text-secondary-foreground ring-1 ring-inset ring-border">
                  {ref.id}
                </span>
                <Combobox
                  aria-label={t('versionAria', { id: ref.id })}
                  className="w-40 shrink-0"
                  options={versionOptions(entry?.versions ?? [], entry?.versionTags)}
                  value={ref.version}
                  onChange={(v) =>
                    onChange(value.map((x) => (x.id === ref.id ? { ...x, version: v } : x)))
                  }
                  searchable={false}
                />
                <button
                  type="button"
                  aria-label={t('remove', { id: ref.id })}
                  onClick={() => onChange(value.filter((x) => x.id !== ref.id))}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-destructive"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
