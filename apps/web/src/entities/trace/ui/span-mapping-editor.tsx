'use client'

import { useTranslations } from 'next-intl'

import { Input } from '@/shared/ui/input'

import { SPAN_MAPPING_FIELDS, type SpanMappingRecord } from '../model/mapping'

// Span-attribute mapping editor (otel/mlflow) — the conversion layer between a harness's spans and the judge's
// TraceEvents. Each row maps a canonical TraceEvent field to that harness's own comma-separated span-attribute keys.
// `rawAttrKeys` (the keys observed on the picked trace) are shown as a reference so the user knows what to map.
export function SpanMappingEditor({
  mapping,
  onChange,
  rawAttrKeys = [],
}: {
  mapping: SpanMappingRecord
  onChange: (next: SpanMappingRecord) => void
  rawAttrKeys?: string[]
}) {
  const t = useTranslations('spanMapping')

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-[12px] text-muted-foreground">{t('subtitle')}</p>
      {rawAttrKeys.length > 0 && (
        <div className="space-y-1">
          <span className="text-[11px] font-[510] text-muted-foreground">{t('availableKeys')}</span>
          <div className="flex flex-wrap gap-1">
            {rawAttrKeys.map((k) => (
              <code
                key={k}
                className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {k}
              </code>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {SPAN_MAPPING_FIELDS.map((f) => (
          <label key={f} className="space-y-1">
            <span className="font-mono text-[11px] text-muted-foreground">{t(`field_${f}`)}</span>
            <Input
              value={mapping[f]}
              onChange={(e) => onChange({ ...mapping, [f]: e.target.value })}
              placeholder={t('placeholder')}
              className="font-mono text-[12px]"
            />
          </label>
        ))}
      </div>
    </div>
  )
}
