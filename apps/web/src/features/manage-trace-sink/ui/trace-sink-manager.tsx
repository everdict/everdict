'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

import { SecretPicker } from '@/features/pick-secret'
import { type TraceScopeOption } from '@/entities/trace-probe'
import type { TraceSinkConfig, TraceSinkKind } from '@/entities/trace-sink'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  probeTraceSinkAction,
  removeTraceSinkAction,
  upsertTraceSinkAction,
} from '../api/manage-trace-sink'

// Meaning of the project field per kind — align the label to the platform's terminology (one field, per-kind coordinate).
const KIND_META: Record<TraceSinkKind, { label: string; projectKey: string }> = {
  mlflow: { label: 'MLflow', projectKey: 'projectMlflow' },
  langfuse: { label: 'Langfuse', projectKey: 'projectLangfuse' },
  langsmith: { label: 'LangSmith', projectKey: 'projectLangsmith' },
  phoenix: { label: 'Phoenix', projectKey: 'projectPhoenix' },
}

type ProbeState = {
  status: 'idle' | 'testing' | 'ok' | 'fail'
  key?: string // the (kind|endpoint|authName) fingerprint the probe ran against — a change invalidates it
  detail?: string
  reason?: 'auth' | 'unreachable' | 'error'
  scopes: TraceScopeOption[]
}

// Workspace trace sinks (multiple) — register several observability platforms and export each case's trace+scores after
// scorecard grading. Registration is gated on a successful "Test connection" that also discovers the platform's selectable
// project scopes (optional for a sink) — no raw scope typing. Auth values are stored only as workspace secret references.
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
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle', scopes: [] })
  const names = [...new Set([...secretNames, ...created])]
  const meta = KIND_META[kind]

  // The connection fingerprint the probe must match — editing kind/endpoint/secret invalidates a prior probe (re-test).
  const probeKey = `${kind}|${endpoint.trim()}|${authName.trim()}`
  const probeFresh = probe.key === probeKey
  const reachable = probe.status === 'ok' && probeFresh
  // project is optional for a sink — Save only needs a reachable connection.
  const canSave = reachable && !pending

  function resetForm() {
    setEditing(undefined)
    setName('')
    setKind('mlflow')
    setEndpoint('')
    setAuthName('')
    setProject('')
    setWebUrl('')
    setProbe({ status: 'idle', scopes: [] })
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
    setProbe({ status: 'idle', scopes: [] }) // editing requires re-testing (stored scope may not be in the fresh list)
  }

  function onTest() {
    setError(undefined)
    if (!endpoint.trim()) {
      setError(t('endpointRequired'))
      return
    }
    const key = probeKey
    setProbe({ status: 'testing', key, scopes: [] })
    startTransition(async () => {
      const r = await probeTraceSinkAction({
        kind,
        endpoint: endpoint.trim(),
        ...(authName.trim() ? { authSecretName: authName.trim() } : {}),
      })
      if (!r.ok) {
        setProbe({ status: 'fail', key, reason: 'error', detail: r.error, scopes: [] })
        return
      }
      const res = r.result
      setProbe({
        status: res.reachable ? 'ok' : 'fail',
        key,
        detail: res.detail,
        reason: res.reason,
        scopes: res.scopes ?? [],
      })
      if (res.reachable) {
        const ids = new Set((res.scopes ?? []).map((s) => s.id))
        if (project && !ids.has(project)) setProject('')
      }
    })
  }

  function onSave() {
    setError(undefined)
    if (!name.trim()) {
      setError(t('nameRequired'))
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

          {/* Test connection — validates the base URL + resolved secret AND discovers the selectable scopes. Save is gated on it. */}
          <div className="space-y-2 rounded-md border border-dashed bg-muted/30 p-3">
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={pending || !endpoint.trim()}
                onClick={onTest}
              >
                {probe.status === 'testing' ? t('testing') : t('testConnection')}
              </Button>
              {reachable ? (
                <span className="text-[12px] font-[510] text-success">{t('probeConnected')}</span>
              ) : (
                <span className="text-[12px] text-muted-foreground">{t('mustTest')}</span>
              )}
            </div>
            {probe.status === 'fail' && probeFresh && (
              <Callout tone="danger" className="py-1.5">
                {probe.reason === 'auth'
                  ? t('probeAuthFailed')
                  : probe.reason === 'unreachable'
                    ? t('probeUnreachable')
                    : t('probeError')}
                {probe.detail && (
                  <span className="mt-0.5 block break-all font-mono text-[11px] opacity-80">
                    {probe.detail}
                  </span>
                )}
              </Callout>
            )}
            {/* Optional project scope — strict select-only from the probe (a "none" option leaves it unset). */}
            {reachable && probe.scopes.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor="ts-project">{t(meta.projectKey)}</Label>
                <Combobox
                  id="ts-project"
                  options={[
                    { value: '', label: t('scopeNone') },
                    ...probe.scopes.map((s) => ({ value: s.id, label: s.name })),
                  ]}
                  value={project}
                  onChange={setProject}
                  aria-label={t('scopeSelectLabel')}
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" disabled={!canSave} onClick={onSave}>
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
