'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/input'

import { SPAN_MAPPING_FIELDS } from '../lib/build-spec'

// Per-harness span-attribute mapping editor (otel/mlflow) — the escape hatch for a harness that doesn't emit the OTel
// GenAI conventions. Each row maps a TraceEvent field to that harness's own comma-separated span-attribute keys.
// Collapsed by default (advanced); a filled field expands it so the override is visible on edit.
export function SpanMappingEditor({
  mapping,
  onChange,
}: {
  mapping: Record<string, string>
  onChange: (next: Record<string, string>) => void
}) {
  const t = useTranslations('spanMapping')
  const hasAny = Object.values(mapping).some((v) => v.trim())
  const [open, setOpen] = useState(hasAny)

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[12px] font-[510] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {t('heading')}
        {!open && hasAny ? <span className="text-primary">•</span> : null}
      </button>
      {open ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-[12px] text-muted-foreground">{t('subtitle')}</p>
          <div className={cn('grid gap-2 sm:grid-cols-2')}>
            {SPAN_MAPPING_FIELDS.map((f) => (
              <label key={f} className="space-y-1">
                <span className="font-mono text-[11px] text-muted-foreground">{t(`field_${f}`)}</span>
                <Input
                  value={mapping[f] ?? ''}
                  onChange={(e) => onChange({ ...mapping, [f]: e.target.value })}
                  placeholder={t('placeholder')}
                  className="font-mono text-[12px]"
                />
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
