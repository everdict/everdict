'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

import { SecretPicker } from '@/features/pick-secret'
import type { TraceSinkConfig, TraceSinkKind } from '@/entities/trace-sink'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { removeTraceSinkAction, upsertTraceSinkAction } from '../api/manage-trace-sink'

// Meaning of the project field per kind — align the label/placeholder to the platform's terminology (one field, per-kind coordinate).
// label is the product name (not translated); project/placeholder are message keys resolved at runtime.
const KIND_META: Record<
  TraceSinkKind,
  { label: string; projectKey: string; placeholderKey: string }
> = {
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

// Workspace trace sinks (multiple) — register several observability platforms (MLflow/Langfuse/LangSmith/Phoenix), and
// when scorecard grading finishes, each case's trace+scores are exported to the sink selected per harness, while the scorecard
// keeps only a summary and external deep links. Which sink to export to is chosen per harness on the harness detail page.
// Auth values are stored only as workspace secret references (names).
export function TraceSinkManager({
  sinks,
  canWrite,
  secretNames,
}: {
  sinks: TraceSinkConfig[]
  canWrite: boolean
  secretNames: string[]
}) {
  const t = useTranslations('manageTraceSink')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  // name being edited — clicking a row prefills the form (saving is an upsert keyed by name). undefined = add a new sink.
  const [editing, setEditing] = useState<string>()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TraceSinkKind>('mlflow')
  const [endpoint, setEndpoint] = useState('')
  const [authName, setAuthName] = useState('')
  const [project, setProject] = useState('')
  const [webUrl, setWebUrl] = useState('')
  const [created, setCreated] = useState<string[]>([])
  const names = [...new Set([...secretNames, ...created])]
  const meta = KIND_META[kind]

  function resetForm() {
    setEditing(undefined)
    setName('')
    setKind('mlflow')
    setEndpoint('')
    setAuthName('')
    setProject('')
    setWebUrl('')
  }

  function startEdit(s: TraceSinkConfig) {
    setError(undefined)
    setEditing(s.name)
    setName(s.name)
    setKind(s.kind)
    setEndpoint(s.endpoint)
    setAuthName(s.authSecretName ?? '')
    setProject(s.project ?? '')
    setWebUrl(s.webUrl ?? '')
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
      const r = await upsertTraceSinkAction({
        name: name.trim(),
        kind,
        endpoint: endpoint.trim(),
        ...(authName.trim() ? { authSecretName: authName.trim() } : {}),
        ...(project.trim() ? { project: project.trim() } : {}),
        ...(webUrl.trim() ? { webUrl: webUrl.trim() } : {}),
      })
      if (!r.ok) setError(r.error)
      else resetForm()
    })
  }

  function onRemove(target: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await removeTraceSinkAction(target)
      if (!r.ok) setError(r.error)
      else if (editing === target) resetForm()
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
          {t('heading')}
          <InfoTip content={t('sinkInfoTip')} />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t('description')}</p>
      </div>

      {sinks.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('empty')}</p>
      ) : (
        <SettingsList>
          {sinks.map((s) => (
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
            {editing ? t('editTitle', { name: editing }) : t('newSink')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ts-name">{t('name')}</Label>
              {/* name = upsert key — lock it while editing to prevent accidentally creating a separate sink (rename ≠ upsert). */}
              <Input
                id="ts-name"
                placeholder={t('namePlaceholder')}
                value={name}
                disabled={editing !== undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ts-kind">{t('platform')}</Label>
              <Combobox
                id="ts-kind"
                options={(Object.keys(KIND_META) as TraceSinkKind[]).map((k) => ({
                  value: k,
                  label: KIND_META[k].label,
                }))}
                value={kind}
                onChange={(v) => setKind(v as TraceSinkKind)}
                aria-label={t('platformSelectLabel')}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ts-endpoint">{t('apiBaseUrl')}</Label>
              <Input
                id="ts-endpoint"
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
              <Label htmlFor="ts-auth" className="flex items-center gap-1.5">
                {t('authSecret')}
                <InfoTip
                  content={t.rich('authInfoTip', {
                    code: (c) => <span className="font-mono">{c}</span>,
                  })}
                />
              </Label>
              <SecretPicker
                id="ts-auth"
                value={authName}
                onChange={setAuthName}
                names={names}
                scope="workspace"
                onCreated={(n) => setCreated((c) => [...c, n])}
                createValuePlaceholder={t('authValuePlaceholder')}
                aria-label={t('authSecretSelectLabel')}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ts-project">{t(meta.projectKey)}</Label>
              <Input
                id="ts-project"
                placeholder={t(meta.placeholderKey)}
                value={project}
                onChange={(e) => setProject(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ts-web" className="flex items-center gap-1.5">
                {t('webUrlBase')}
                <InfoTip content={t('webUrlInfoTip')} />
              </Label>
              <Input
                id="ts-web"
                placeholder="https://…"
                value={webUrl}
                onChange={(e) => setWebUrl(e.target.value)}
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
