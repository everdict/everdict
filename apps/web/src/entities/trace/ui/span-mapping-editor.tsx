'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  SPAN_MAPPING_FIELDS,
  type SpanMappingField,
  type SpanMappingRecord,
} from '../model/mapping'

// One observed span attribute — a key seen on the picked trace plus a sample value from it, so the user can
// recognize what each key holds without knowing the harness's naming upfront.
export interface SpanAttrOption {
  key: string
  sample?: string
}

function fieldKeys(mapping: SpanMappingRecord, field: SpanMappingField): string[] {
  return (mapping[field] ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
}

// Click-to-add popover over the observed attribute keys (typed search doubles as a custom-key escape hatch).
function AddKeyButton({
  options,
  assigned,
  onAdd,
  label,
}: {
  options: SpanAttrOption[]
  assigned: string[]
  onAdd: (key: string) => void
  label: string
}) {
  const t = useTranslations('spanMapping')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const available = useMemo(
    () => options.filter((o) => !assigned.includes(o.key)),
    [options, assigned]
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return available
    return available.filter(
      (o) => o.key.toLowerCase().includes(q) || (o.sample?.toLowerCase().includes(q) ?? false)
    )
  }, [available, query])
  // A typed query that matches no observed key exactly can still be added verbatim (unobserved-key escape hatch).
  const custom = query.trim()
  const showCustom =
    custom.length > 0 && !assigned.includes(custom) && !available.some((o) => o.key === custom)

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    searchRef.current?.focus()
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function commit(key: string) {
    onAdd(key)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`${t('addKey')} — ${label}`}
        aria-expanded={open}
        className={cn(
          'flex h-6 items-center gap-1 rounded-md border border-dashed border-border px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground',
          open && 'border-primary text-foreground'
        )}
      >
        <Plus className="size-3" />
        {t('addKey')}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-80 overflow-hidden rounded-lg border border-border bg-popover p-1 text-[12px] shadow-pop origin-top animate-in fade-in-0 zoom-in-95 duration-100">
          <div className="mb-1 flex items-center gap-1.5 border-b border-border px-1.5 pb-1.5 pt-0.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false)
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const first = filtered[0]
                  if (first) commit(first.key)
                  else if (showCustom) commit(custom)
                }
              }}
              placeholder={t('searchKeys')}
              className="h-6 w-full bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 && !showCustom && (
              <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                {t('noKeys')}
              </p>
            )}
            {filtered.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => commit(o.key)}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
              >
                <span className="truncate font-mono text-[11px] text-foreground">{o.key}</span>
                {o.sample !== undefined && (
                  <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                    {o.sample}
                  </span>
                )}
              </button>
            ))}
            {showCustom && (
              <button
                type="button"
                onClick={() => commit(custom)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                <Plus className="size-3 shrink-0" />
                {t('useCustomKey', { key: custom })}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Span-attribute mapping builder (otel/mlflow) — the conversion layer between a harness's spans and the judge's
// TraceEvents, authored entirely with the mouse: each row maps a canonical TraceEvent field to span-attribute keys
// picked from the ones actually observed on the sample trace (with their sample values), never typed blind.
export function SpanMappingEditor({
  mapping,
  onChange,
  attrs = [],
}: {
  mapping: SpanMappingRecord
  onChange: (next: SpanMappingRecord) => void
  attrs?: SpanAttrOption[]
}) {
  const t = useTranslations('spanMapping')

  function add(field: SpanMappingField, key: string) {
    onChange({ ...mapping, [field]: [...fieldKeys(mapping, field), key].join(', ') })
  }
  function remove(field: SpanMappingField, key: string) {
    onChange({
      ...mapping,
      [field]: fieldKeys(mapping, field)
        .filter((k) => k !== key)
        .join(', '),
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <span className="text-[12px] font-[510] text-muted-foreground">
          {t('builderHeading')}
        </span>
        <InfoTip content={t('builderTip')} />
      </div>
      <div className="divide-y divide-border/60 rounded-lg border border-border bg-muted/20">
        {SPAN_MAPPING_FIELDS.map((f) => {
          const keys = fieldKeys(mapping, f)
          return (
            <div key={f} className="flex items-center gap-3 px-3 py-1.5">
              <span className="w-28 shrink-0 font-mono text-[11px] text-muted-foreground">
                {t(`field_${f}`)}
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {keys.length === 0 && (
                  <span className="text-[11px] text-faint">{t('defaultKeys')}</span>
                )}
                {keys.map((k) => (
                  <span
                    key={k}
                    className="flex items-center gap-1 rounded-md border border-primary/25 bg-primary/6 px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                  >
                    {k}
                    <button
                      type="button"
                      onClick={() => remove(f, k)}
                      aria-label={t('removeKey', { key: k })}
                      className="text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
                <AddKeyButton
                  options={attrs}
                  assigned={keys}
                  onAdd={(key) => add(f, key)}
                  label={t(`field_${f}`)}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
