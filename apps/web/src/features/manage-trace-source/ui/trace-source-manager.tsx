'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

import { SecretPicker } from '@/features/pick-secret'
import type { TraceSourceConfig, TraceSourceKind } from '@/entities/trace-source'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { removeTraceSourceAction, upsertTraceSourceAction } from '../api/manage-trace-source'

// Meaning of the project field per kind — align the label/placeholder to the platform's terminology (one field, per-kind coordinate).
// label is the product name (not translated); project/placeholder are message keys resolved at runtime.
const KIND_META: Record<
  TraceSourceKind,
  { label: string; projectKey: string; placeholderKey: string }
> = {
  otel: { label: 'OTel', projectKey: 'projectOtel', placeholderKey: 'placeholderOtel' },
  mlflow: { label: 'MLflow', projectKey: 'projectMlflow', placeholderKey: 'placeholderMlflow' },
  langfuse: {
    label: 'Langfuse',
    projectKey: 'projectLangfuse',
    placeholderKey: 'placeholderLangfuse',
  },
  langsmith: {
    label: 'LangSmith',
    projectKey: 'projectLangsmith',
    placeholderKey: 'placeholderLangsmith',
  },
  phoenix: { label: 'Phoenix', projectKey: 'projectPhoenix', placeholderKey: 'placeholderPhoenix' },
}

// Workspace trace sources (multiple) — register several observability platforms (OTel/MLflow/Langfuse/LangSmith/Phoenix), and
// when a harness deployed on the dev cluster is evaluated, its trace is pulled from the source selected per harness so the pulled
// trace can be scored. Which source to pull from is chosen per harness on the harness detail page.
// Auth values are stored only as workspace secret references (names).
export function TraceSourceManager({
  sources,
  canWrite,
  secretNames,
}: {
  sources: TraceSourceConfig[]
  canWrite: boolean
  secretNames: string[]
}) {
  const t = useTranslations('manageTraceSource')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  // name being edited — clicking a row prefills the form (saving is an upsert keyed by name). undefined = add a new source.
  const [editing, setEditing] = useState<string>()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TraceSourceKind>('otel')
  const [endpoint, setEndpoint] = useState('')
  const [authName, setAuthName] = useState('')
  const [correlate, setCorrelate] = useState<'id' | 'tag'>('id')
  const [service, setService] = useState('')
  const [project, setProject] = useState('')
  const [created, setCreated] = useState<string[]>([])
  const names = [...new Set([...secretNames, ...created])]
  const meta = KIND_META[kind]

  function resetForm() {
    setEditing(undefined)
    setName('')
    setKind('otel')
    setEndpoint('')
    setAuthName('')
    setCorrelate('id')
    setService('')
    setProject('')
  }

  function startEdit(s: TraceSourceConfig) {
    setError(undefined)
    setEditing(s.name)
    setName(s.name)
    setKind(s.kind)
    setEndpoint(s.endpoint)
    setAuthName(s.authSecretName ?? '')
    setCorrelate(s.correlate)
    setService(s.service ?? '')
    setProject(s.project ?? '')
  }

  function onSave() {
    setError(undefined)
    if (!name.trim()) {
      setError(t('nameRequired'))
      return
    }
    if (!endpoint.trim()) {
      setError(t('endpointRequired'))
      return
    }
    startTransition(async () => {
      const r = await upsertTraceSourceAction({
        name: name.trim(),
        kind,
        endpoint: endpoint.trim(),
        correlate,
        ...(authName.trim() ? { authSecretName: authName.trim() } : {}),
        ...(service.trim() ? { service: service.trim() } : {}),
        ...(project.trim() ? { project: project.trim() } : {}),
      })
      if (!r.ok) setError(r.error)
      else resetForm()
    })
  }

  function onRemove(target: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await removeTraceSourceAction(target)
      if (!r.ok) setError(r.error)
      else if (editing === target) resetForm()
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
          {t('heading')}
          <InfoTip content={t('sourceInfoTip')} />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t('description')}</p>
      </div>

      {sources.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('empty')}</p>
      ) : (
        <SettingsList>
          {sources.map((s) => (
            <SettingsRow
              key={s.name}
              label={
                <span className="inline-flex items-center gap-1.5">
                  {s.name}
                  <Badge tone="info">{KIND_META[s.kind].label}</Badge>
                </span>
              }
              hint={<span className="break-all font-mono text-[11.5px]">{s.endpoint}</span>}
            >
              {canWrite && (
                <>
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-link hover:text-foreground"
                    disabled={pending}
                    onClick={() => startEdit(s)}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-destructive hover:underline"
                    disabled={pending}
                    onClick={() => onRemove(s.name)}
                  >
                    {t('delete')}
                  </button>
                </>
              )}
            </SettingsRow>
          ))}
        </SettingsList>
      )}

      {canWrite && (
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
          <p className="text-[12px] font-[560] text-foreground">
            {editing ? t('editTitle', { name: editing }) : t('newSource')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="tsrc-name">{t('name')}</Label>
              {/* name = upsert key — lock it while editing to prevent accidentally creating a separate source (rename ≠ upsert). */}
              <Input
                id="tsrc-name"
                placeholder={t('namePlaceholder')}
                value={name}
                disabled={editing !== undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tsrc-kind">{t('platform')}</Label>
              <Combobox
                id="tsrc-kind"
                options={(Object.keys(KIND_META) as TraceSourceKind[]).map((k) => ({
                  value: k,
                  label: KIND_META[k].label,
                }))}
                value={kind}
                onChange={(v) => setKind(v as TraceSourceKind)}
                aria-label={t('platformSelectLabel')}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tsrc-endpoint">{t('apiBaseUrl')}</Label>
              <Input
                id="tsrc-endpoint"
                placeholder={
                  kind === 'langsmith'
                    ? 'https://api.smith.langchain.com'
                    : 'http://mlflow.corp.io:5000'
                }
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </div>
            {/* The auth value is a workspace secret reference, not free text — choose or create inline. */}
            <div className="space-y-1">
              <Label htmlFor="tsrc-auth" className="flex items-center gap-1.5">
                {t('authSecret')}
                <InfoTip
                  content={t.rich('authInfoTip', {
                    code: (c) => <span className="font-mono">{c}</span>,
                  })}
                />
              </Label>
              <SecretPicker
                id="tsrc-auth"
                value={authName}
                onChange={setAuthName}
                names={names}
                scope="workspace"
                onCreated={(n) => setCreated((c) => [...c, n])}
                createValuePlaceholder={t('authValuePlaceholder')}
                aria-label={t('authSecretSelectLabel')}
              />
            </div>
            {/* Correlation strategy — how the pulled trace is matched to the everdict run (the everdict runId IS the trace id, or search a tag the agent set). */}
            <div className="space-y-1">
              <Label htmlFor="tsrc-correlate" className="flex items-center gap-1.5">
                {t('correlate')}
                <InfoTip content={t('correlateInfoTip')} />
              </Label>
              <Combobox
                id="tsrc-correlate"
                options={[
                  { value: 'id', label: t('correlateId') },
                  { value: 'tag', label: t('correlateTag') },
                ]}
                value={correlate}
                onChange={(v) => setCorrelate(v === 'tag' ? 'tag' : 'id')}
                aria-label={t('correlateLabel')}
              />
            </div>
            {/* service.name — meaningful for otel/jaeger tag search; always rendered so it can be set for any tag-correlated source. */}
            <div className="space-y-1">
              <Label htmlFor="tsrc-service" className="flex items-center gap-1.5">
                {t('service')}
                <InfoTip content={t('serviceInfoTip')} />
              </Label>
              <Input
                id="tsrc-service"
                placeholder="e.g. my-agent"
                value={service}
                onChange={(e) => setService(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tsrc-project">{t(meta.projectKey)}</Label>
              <Input
                id="tsrc-project"
                placeholder={t(meta.placeholderKey)}
                value={project}
                onChange={(e) => setProject(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" disabled={pending} onClick={onSave}>
              {pending ? t('saving') : editing ? t('update') : t('register')}
            </Button>
            {editing && (
              <button
                type="button"
                className="text-[12px] text-muted-foreground hover:text-foreground"
                disabled={pending}
                onClick={resetForm}
              >
                {t('cancel')}
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
