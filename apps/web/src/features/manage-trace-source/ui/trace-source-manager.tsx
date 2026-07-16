'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

import { SecretPicker } from '@/features/pick-secret'
import { type TraceScopeOption } from '@/entities/trace-probe'
import type { TraceSourceConfig, TraceSourceKind } from '@/entities/trace-source'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  probeTraceSourceAction,
  removeTraceSourceAction,
  upsertTraceSourceAction,
} from '../api/manage-trace-source'

// Meaning of the project field per kind — align the label to the platform's terminology (one field, per-kind coordinate).
const KIND_META: Record<TraceSourceKind, { label: string; projectKey: string }> = {
  otel: { label: 'OTel', projectKey: 'projectOtel' },
  mlflow: { label: 'MLflow', projectKey: 'projectMlflow' },
  langfuse: { label: 'Langfuse', projectKey: 'projectLangfuse' },
  langsmith: { label: 'LangSmith', projectKey: 'projectLangsmith' },
  phoenix: { label: 'Phoenix', projectKey: 'projectPhoenix' },
}

// Which config field a discovered scope binds to (and whether it is required to register), given kind + correlate.
//  - otel: correlate:'tag' needs `service` (the Jaeger search scope); correlate:'id' needs nothing.
//  - mlflow: correlate:'tag' needs `project` (experiment_id search scope); correlate:'id' needs nothing.
//  - phoenix: always needs `project` (the span-query path).
//  - langfuse/langsmith: the source doesn't consume a scope — the probe is validation-only.
function scopeRequirement(
  kind: TraceSourceKind,
  correlate: 'id' | 'tag'
): { field: 'service' | 'project'; required: boolean } | null {
  if (kind === 'otel') return correlate === 'tag' ? { field: 'service', required: true } : null
  if (kind === 'mlflow') return correlate === 'tag' ? { field: 'project', required: true } : null
  if (kind === 'phoenix') return { field: 'project', required: true }
  return null // langfuse, langsmith
}

type ProbeState = {
  status: 'idle' | 'testing' | 'ok' | 'fail'
  key?: string // the (kind|endpoint|authName) fingerprint the probe ran against — a change invalidates it
  detail?: string
  reason?: 'auth' | 'unreachable' | 'error'
  scopes: TraceScopeOption[]
}

// Workspace trace sources (multiple) — register several observability platforms and pull a dev-cluster-deployed
// harness's trace after a case runs so it can be scored. Registration is gated on a successful "Test connection"
// that also discovers the platform's selectable scopes (experiment/project/service) — no raw scope typing.
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
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle', scopes: [] })
  const names = [...new Set([...secretNames, ...created])]
  const meta = KIND_META[kind]

  // The connection fingerprint the probe must match — editing kind/endpoint/secret invalidates a prior probe (re-test).
  const probeKey = `${kind}|${endpoint.trim()}|${authName.trim()}`
  const probeFresh = probe.key === probeKey
  const reachable = probe.status === 'ok' && probeFresh
  const req = scopeRequirement(kind, correlate)
  const scopeValue = req?.field === 'service' ? service : req?.field === 'project' ? project : ''
  // Strict select-only: a required scope must be chosen from the discovered list; an empty list blocks registration.
  const scopeMissing = req?.required === true && !scopeValue
  const canSave = reachable && !scopeMissing && !pending

  function resetForm() {
    setEditing(undefined)
    setName('')
    setKind('otel')
    setEndpoint('')
    setAuthName('')
    setCorrelate('id')
    setService('')
    setProject('')
    setProbe({ status: 'idle', scopes: [] })
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
      const r = await probeTraceSourceAction({
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
      // Clear a stale scope selection that is no longer offered by this platform.
      if (res.reachable) {
        const ids = new Set((res.scopes ?? []).map((s) => s.id))
        if (service && !ids.has(service)) setService('')
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
            {/* Strict select-only scope picker — options come ONLY from the probe. Shown when the config needs a scope. */}
            {reachable && req && (
              <div className="space-y-1">
                <Label htmlFor="tsrc-scope">
                  {req.field === 'service' ? t('service') : t(meta.projectKey)}
                </Label>
                {probe.scopes.length > 0 ? (
                  <Combobox
                    id="tsrc-scope"
                    options={probe.scopes.map((s) => ({ value: s.id, label: s.name }))}
                    value={scopeValue}
                    onChange={(v) => (req.field === 'service' ? setService(v) : setProject(v))}
                    aria-label={t('scopeSelectLabel')}
                  />
                ) : (
                  <Callout tone="warning" className="py-1.5">
                    {t('scopeEmpty')}
                  </Callout>
                )}
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
