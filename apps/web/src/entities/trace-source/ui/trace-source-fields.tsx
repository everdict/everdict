'use client'

import { useTranslations } from 'next-intl'

import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

// The embedded trace-source config shared by the harness and runtime wizards — one subform so the two never drift
// again (they used to offer only otel/mlflow with no auth/correlation). Controlled: the parent owns the state and
// passes value + a patch callback. authSecret is a SecretStore key NAME (a plain input, like the runtime wizard's
// other secret-name fields) — the value is resolved by the control plane, never entered here.
export interface TraceSourceValue {
  kind: string // otel | mlflow | langfuse | langsmith | phoenix
  endpoint: string
  authSecret: string // SecretStore key name for the platform auth header ('' = none)
  correlate: string // '' (default) | id | tag — how the platform finds THIS run's trace
  service: string // otel/jaeger service scope ('' = unset)
  project: string // mlflow experiment / langsmith project / phoenix project / langfuse projectId ('' = unset)
}

export const EMPTY_TRACE_SOURCE: TraceSourceValue = {
  kind: 'otel',
  endpoint: '',
  authSecret: '',
  correlate: '',
  service: '',
  project: '',
}

const KIND_OPTIONS = [
  { value: 'otel', label: 'OTel' },
  { value: 'mlflow', label: 'MLflow' },
  { value: 'langfuse', label: 'Langfuse' },
  { value: 'langsmith', label: 'LangSmith' },
  { value: 'phoenix', label: 'Phoenix' },
]

export function TraceSourceFields({
  value,
  onChange,
}: {
  value: TraceSourceValue
  onChange: (patch: Partial<TraceSourceValue>) => void
}) {
  const t = useTranslations('traceSourceFields')
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>{t('kindLabel')}</Label>
          <Combobox
            value={value.kind}
            onChange={(v) => onChange({ kind: v })}
            options={KIND_OPTIONS}
            searchable={false}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t('endpointLabel')}</Label>
          <Input
            value={value.endpoint}
            onChange={(e) => onChange({ endpoint: e.target.value })}
            placeholder="http://mlflow.internal:5000"
            autoComplete="off"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label>{t('correlateLabel')}</Label>
            <InfoTip content={t('correlateTip')} />
          </div>
          <Combobox
            value={value.correlate}
            onChange={(v) => onChange({ correlate: v })}
            options={[
              { value: '', label: t('correlateDefault') },
              { value: 'id', label: t('correlateId') },
              { value: 'tag', label: t('correlateTag') },
            ]}
            searchable={false}
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label>{t('authSecretLabel')}</Label>
            <InfoTip content={t('authSecretTip')} />
          </div>
          <Input
            value={value.authSecret}
            onChange={(e) => onChange({ authSecret: e.target.value })}
            placeholder="mlflow-token"
            autoComplete="off"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label>{t('serviceLabel')}</Label>
            <InfoTip content={t('serviceTip')} />
          </div>
          <Input
            value={value.service}
            onChange={(e) => onChange({ service: e.target.value })}
            placeholder="agent"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label>{t('projectLabel')}</Label>
            <InfoTip content={t('projectTip')} />
          </div>
          <Input
            value={value.project}
            onChange={(e) => onChange({ project: e.target.value })}
            placeholder="my-experiment"
            autoComplete="off"
          />
        </div>
      </div>
    </div>
  )
}

// Build the spec's traceSource fragment from the form value — empty optionals omitted (kind/endpoint always present).
export function traceSourceToSpec(v: TraceSourceValue): Record<string, unknown> {
  return {
    kind: v.kind,
    endpoint: v.endpoint.trim(),
    ...(v.authSecret.trim() ? { authSecret: v.authSecret.trim() } : {}),
    ...(v.correlate ? { correlate: v.correlate } : {}),
    ...(v.service.trim() ? { service: v.service.trim() } : {}),
    ...(v.project.trim() ? { project: v.project.trim() } : {}),
  }
}
