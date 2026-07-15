'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, ClipboardCheck, Loader2, Plug } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { RuntimeSpec } from '@/entities/runtime'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'

import {
  createRuntimeAction,
  probeRuntimeAction,
  validateRuntimeAction,
} from '../api/register-runtime'

type Kind = 'nomad' | 'k8s'

// Registrable infra kinds — local (dev-only) and docker (single host, absorbed into the self-hosted runner in slice 5b) are excluded
// from the register UI. "My machine / single docker host" connects as a runner, and container execution is a docker capability, not a runtime kind.
const KINDS: { value: Kind; label: string; descriptionKey: string }[] = [
  { value: 'nomad', label: 'Nomad', descriptionKey: 'kindNomadDescription' },
  { value: 'k8s', label: 'Kubernetes', descriptionKey: 'kindK8sDescription' },
]

interface Fields {
  kind: Kind
  id: string
  version: string
  description: string
  tags: string
  image: string
  addr: string
  namespace: string
  datacenters: string
  runtime: string
  context: string
  runtimeClass: string
  server: string
  authSecret: string
  kubeconfigSecret: string
  maxConcurrent: string
  memoryBudgetMb: string
  cpuBudget: string
  supportsTopology: boolean
  browserImage: string
  traceKind: 'otel' | 'mlflow'
  traceEndpoint: string
}

const INITIAL: Fields = {
  kind: 'nomad',
  id: '',
  version: '1.0.0',
  description: '',
  tags: '',
  image: '',
  addr: '',
  namespace: '',
  datacenters: '',
  runtime: '',
  context: '',
  runtimeClass: '',
  server: '',
  authSecret: '',
  kubeconfigSecret: '',
  maxConcurrent: '',
  memoryBudgetMb: '',
  cpuBudget: '',
  supportsTopology: false,
  browserImage: '',
  traceKind: 'otel',
  traceEndpoint: '',
}

// RuntimeSpec (GET /runtimes/:id/versions/:v) → editable form Fields — the inverse of buildSpec. Arrays/nested config flatten back to
// the form's string inputs, and an absent optional becomes the empty "unset" string (the same representation INITIAL uses).
function fieldsFromSpec(spec: RuntimeSpec): Fields {
  const str = (v: string | undefined) => v ?? ''
  const num = (v: number | undefined) => (v === undefined ? '' : String(v))
  const trace = spec.traceSource
  return {
    kind: spec.kind === 'k8s' ? 'k8s' : 'nomad',
    id: spec.id,
    version: spec.version,
    description: str(spec.description),
    tags: (spec.tags ?? []).join(', '),
    image: str(spec.image),
    addr: str(spec.addr),
    namespace: str(spec.namespace),
    datacenters: (spec.datacenters ?? []).join(', '),
    runtime: str(spec.runtime),
    context: str(spec.context),
    runtimeClass: str(spec.runtimeClass),
    server: str(spec.server),
    authSecret: str(spec.authSecret),
    kubeconfigSecret: str(spec.kubeconfigSecret),
    maxConcurrent: num(spec.maxConcurrent),
    memoryBudgetMb: num(spec.memoryBudgetMb),
    cpuBudget: num(spec.cpuBudget),
    supportsTopology: trace !== undefined,
    browserImage: str(spec.browserImage),
    traceKind: trace?.kind === 'mlflow' ? 'mlflow' : 'otel',
    traceEndpoint: str(trace?.endpoint),
  }
}

const csv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

// Hardened (strong-isolation) runtime names — mirrors core trust-zone HARDENED_RUNTIMES (nomad runtime / k8s runtimeClass).
const HARDENED = new Set(['runsc', 'gvisor', 'kata', 'kata-runtime', 'firecracker', 'fc'])

// Capabilities this runtime provides automatically — the app labels them from the spec (no manual user input; mirrors core defaultRuntimeCapabilities).
function runtimeCaps(f: Fields): string[] {
  const caps = ['docker'] // nomad/k8s run container images
  const iso = (f.kind === 'nomad' ? f.runtime : f.runtimeClass).trim()
  if (iso && HARDENED.has(iso)) caps.push('sandbox') // strong-isolation runtime
  if (f.supportsTopology) caps.push('topology')
  return caps
}

// Form → RuntimeSpec. Empty optionals are excluded to fit the server schema (discriminatedUnion). capabilities are auto-labeled by the app.
// submitVersion (edit mode) overrides the (hidden) version field — the caller computes the next version so an edit registers a fresh immutable one.
function buildSpec(f: Fields, submitVersion?: string): Record<string, unknown> {
  const t = (v: string) => v.trim()
  const base: Record<string, unknown> = {
    kind: f.kind,
    id: t(f.id),
    version: submitVersion ?? (t(f.version) || '1.0.0'),
    ...(t(f.description) ? { description: t(f.description) } : {}),
    ...(csv(f.tags).length ? { tags: csv(f.tags) } : {}),
  }
  const opt = (k: string, v: string) => (t(v) ? { [k]: t(v) } : {})
  // Admission envelope — positive integers only; anything else is treated as unset (the server validates too).
  const posInt = (v: string): number | undefined => {
    const n = Number(t(v))
    return t(v) && Number.isInteger(n) && n > 0 ? n : undefined
  }
  const envelope = {
    ...(posInt(f.maxConcurrent) !== undefined ? { maxConcurrent: posInt(f.maxConcurrent) } : {}),
    ...(posInt(f.memoryBudgetMb) !== undefined ? { memoryBudgetMb: posInt(f.memoryBudgetMb) } : {}),
    ...(posInt(f.cpuBudget) !== undefined ? { cpuBudget: posInt(f.cpuBudget) } : {}),
  }
  const topology = f.supportsTopology
    ? {
        traceSource: { kind: f.traceKind, endpoint: t(f.traceEndpoint) },
        ...opt('browserImage', f.browserImage),
      }
    : {}
  const capabilities = runtimeCaps(f)
  if (f.kind === 'nomad')
    return {
      ...base,
      addr: t(f.addr),
      image: t(f.image),
      ...opt('namespace', f.namespace),
      ...(csv(f.datacenters).length ? { datacenters: csv(f.datacenters) } : {}),
      ...opt('runtime', f.runtime),
      ...opt('authSecret', f.authSecret),
      ...envelope,
      ...topology,
      capabilities,
    }
  // k8s
  return {
    ...base,
    image: t(f.image),
    ...opt('context', f.context),
    ...opt('namespace', f.namespace),
    ...opt('runtimeClass', f.runtimeClass),
    ...opt('server', f.server),
    ...opt('authSecret', f.authSecret),
    ...opt('kubeconfigSecret', f.kubeconfigSecret),
    ...envelope,
    ...topology,
    capabilities,
  }
}

// Client-side required-field check (the server enforces too, but this gives immediate feedback). null = pass. Returns a message catalog key.
function requiredErrorKey(f: Fields): string | null {
  if (!f.id.trim()) return 'errorIdRequired'
  if (!f.version.trim()) return 'errorVersionRequired'
  if (f.kind === 'nomad' && (!f.addr.trim() || !f.image.trim())) return 'errorNomadRequired'
  if (f.kind === 'k8s' && !f.image.trim()) return 'errorK8sImageRequired'
  if (f.supportsTopology && !f.traceEndpoint.trim()) return 'errorTopologyEndpointRequired'
  return null
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[12px] text-faint">{hint}</p>}
    </div>
  )
}

// Workspace infra runtime registration form (nomad/k8s/topology). Credentials aren't entered here; they're referenced by SecretStore key name.
// Edit mode (initial + submitVersion): prefill from the current spec, lock the identity (id/kind), hide the version (the caller bumps it),
// and save back as a fresh immutable version — versioning is an implementation detail, the user just "edits" the runtime.
export function RegisterRuntimeForm({
  workspace,
  initial,
  submitVersion,
}: {
  workspace: string
  initial?: RuntimeSpec
  submitVersion?: string
}) {
  const router = useRouter()
  const t = useTranslations('registerRuntime')
  const editing = initial !== undefined
  const [f, setF] = useState<Fields>(initial ? fieldsFromSpec(initial) : INITIAL)
  const [error, setError] = useState<string>()
  const [probe, setProbe] = useState<{ reachable?: boolean; detail?: string; error?: string }>()
  const [validation, setValidation] = useState<{
    ok?: boolean
    errors?: string[]
    missingSecrets?: string[]
    error?: string
  }>()
  const [probing, startProbe] = useTransition()
  const [validating, startValidate] = useTransition()
  const [saving, startSave] = useTransition()

  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setF((p) => ({ ...p, [k]: v }))
  const kindMeta = useMemo(() => KINDS.find((k) => k.value === f.kind), [f.kind])
  const secretHint = t('secretHint')

  function onProbe() {
    setError(undefined)
    setProbe(undefined)
    const errKey = requiredErrorKey(f)
    if (errKey) {
      setError(t(errKey))
      return
    }
    startProbe(async () => {
      const r = await probeRuntimeAction(buildSpec(f, submitVersion))
      if (r.ok) setProbe({ reachable: r.reachable, detail: r.detail })
      else setProbe({ error: r.error })
    })
  }

  // Dry run — schema validation + referenced-secret existence, without running a job (POST /runtimes/validate).
  function onValidate() {
    setError(undefined)
    setValidation(undefined)
    const errKey = requiredErrorKey(f)
    if (errKey) {
      setError(t(errKey))
      return
    }
    startValidate(async () => {
      const r = await validateRuntimeAction(buildSpec(f, submitVersion))
      if (r.ok)
        setValidation({
          ok: true,
          ...(r.missingSecrets ? { missingSecrets: r.missingSecrets } : {}),
        })
      else
        setValidation({
          ok: false,
          ...(r.errors ? { errors: r.errors } : {}),
          ...(r.error ? { error: r.error } : {}),
        })
    })
  }

  function onSubmit() {
    setError(undefined)
    const errKey = requiredErrorKey(f)
    if (errKey) {
      setError(t(errKey))
      return
    }
    startSave(async () => {
      const r = await createRuntimeAction(buildSpec(f, submitVersion))
      if (r.ok) {
        if (editing) {
          toast.success(t('updated', { id: r.id ?? f.id }))
          router.push(`/${workspace}/runtimes/${encodeURIComponent(f.id)}`)
        } else {
          toast.success(t('registered', { id: r.id ?? '', version: r.version ?? '' }))
          router.push(`/${workspace}/runtimes`)
        }
        router.refresh()
      } else {
        setError(r.error ?? t('errorGeneric'))
      }
    })
  }

  const cluster = f.kind === 'nomad' || f.kind === 'k8s'

  return (
    <div className="max-w-2xl space-y-6">
      {/* Kind — locked on edit (identity is fixed; changing it would be a different runtime). */}
      <div className="space-y-1.5">
        <Label>{t('kindLabel')}</Label>
        <Combobox
          value={f.kind}
          onChange={(v) => set('kind', v as Kind)}
          disabled={editing}
          options={KINDS.map((k) => ({
            value: k.value,
            label: k.label,
            description: t(k.descriptionKey),
          }))}
        />
        {kindMeta && (
          <p className="text-[12px] text-muted-foreground">{t(kindMeta.descriptionKey)}</p>
        )}
      </div>

      {/* Common — id is locked on edit; the version field is hidden (an edit auto-bumps to a fresh version). */}
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('idLabel')} hint={editing ? t('lockedIdentityHint') : t('idHint')}>
          <Input
            value={f.id}
            onChange={(e) => set('id', e.target.value)}
            placeholder="prod-k8s"
            autoComplete="off"
            disabled={editing}
          />
        </Field>
        {!editing && (
          <Field label={t('versionLabel')} hint={t('versionHint')}>
            <Input
              value={f.version}
              onChange={(e) => set('version', e.target.value)}
              placeholder="1.0.0"
              autoComplete="off"
            />
          </Field>
        )}
      </div>

      {/* nomad */}
      {f.kind === 'nomad' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('addrLabel')} hint={t('addrHint')}>
              <Input
                value={f.addr}
                onChange={(e) => set('addr', e.target.value)}
                placeholder="http://nomad.internal:4646"
                autoComplete="off"
              />
            </Field>
            <Field label={t('runnerImageLabel')} hint={t('nomadImageHint')}>
              <Input
                value={f.image}
                onChange={(e) => set('image', e.target.value)}
                placeholder="ghcr.io/acme/agent:latest"
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('namespaceLabel')}>
              <Input
                value={f.namespace}
                onChange={(e) => set('namespace', e.target.value)}
                placeholder="default"
                autoComplete="off"
              />
            </Field>
            <Field label={t('isolationRuntimeLabel')} hint={t('isolationRuntimeHint')}>
              <Input
                value={f.runtime}
                onChange={(e) => set('runtime', e.target.value)}
                placeholder="runsc"
                autoComplete="off"
              />
            </Field>
          </div>
          <Field label={t('datacentersLabel')} hint={t('commaSeparatedHint')}>
            <Input
              value={f.datacenters}
              onChange={(e) => set('datacenters', e.target.value)}
              placeholder="dc1, dc2"
              autoComplete="off"
            />
          </Field>
          <Field label={t('nomadAclSecretLabel')} hint={secretHint}>
            <Input
              value={f.authSecret}
              onChange={(e) => set('authSecret', e.target.value)}
              placeholder="nomad-token"
              autoComplete="off"
            />
          </Field>
        </div>
      )}

      {/* k8s */}
      {f.kind === 'k8s' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('runnerImageLabel')} hint={t('k8sImageHint')}>
              <Input
                value={f.image}
                onChange={(e) => set('image', e.target.value)}
                placeholder="ghcr.io/acme/agent:latest"
                autoComplete="off"
              />
            </Field>
            <Field label={t('namespaceLabel')}>
              <Input
                value={f.namespace}
                onChange={(e) => set('namespace', e.target.value)}
                placeholder="everdict"
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('contextLabel')} hint={t('contextHint')}>
              <Input
                value={f.context}
                onChange={(e) => set('context', e.target.value)}
                placeholder="prod-cluster"
                autoComplete="off"
              />
            </Field>
            <Field label={t('runtimeClassLabel')} hint={t('runtimeClassHint')}>
              <Input
                value={f.runtimeClass}
                onChange={(e) => set('runtimeClass', e.target.value)}
                placeholder="gvisor"
                autoComplete="off"
              />
            </Field>
          </div>
          <Field label={t('apiServerLabel')} hint={t('apiServerHint')}>
            <Input
              value={f.server}
              onChange={(e) => set('server', e.target.value)}
              placeholder="https://k8s.acme.io:6443"
              autoComplete="off"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('k8sAuthSecretLabel')} hint={secretHint}>
              <Input
                value={f.authSecret}
                onChange={(e) => set('authSecret', e.target.value)}
                placeholder="k8s-token"
                autoComplete="off"
              />
            </Field>
            <Field label={t('kubeconfigSecretLabel')} hint={t('kubeconfigSecretHint')}>
              <Input
                value={f.kubeconfigSecret}
                onChange={(e) => set('kubeconfigSecret', e.target.value)}
                placeholder="prod-kubeconfig"
                autoComplete="off"
              />
            </Field>
          </div>
        </div>
      )}

      {/* Admission envelope — how much the control plane may pack onto this runtime concurrently (docs/execution-backends.md) */}
      {cluster && (
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('maxConcurrentLabel')} hint={t('maxConcurrentHint')}>
            <Input
              value={f.maxConcurrent}
              onChange={(e) => set('maxConcurrent', e.target.value)}
              placeholder="20"
              inputMode="numeric"
              autoComplete="off"
            />
          </Field>
          <Field label={t('memoryBudgetLabel')} hint={t('memoryBudgetHint')}>
            <Input
              value={f.memoryBudgetMb}
              onChange={(e) => set('memoryBudgetMb', e.target.value)}
              placeholder="8192"
              inputMode="numeric"
              autoComplete="off"
            />
          </Field>
          <Field label={t('cpuBudgetLabel')} hint={t('cpuBudgetHint')}>
            <Input
              value={f.cpuBudget}
              onChange={(e) => set('cpuBudget', e.target.value)}
              placeholder="4000"
              inputMode="numeric"
              autoComplete="off"
            />
          </Field>
        </div>
      )}

      {/* topology support — adding a traceSource lets this nomad/k8s runtime also host service-topology harnesses (browser-use, etc.) (topology capability) */}
      <div className="space-y-3 rounded-lg border bg-card px-4 py-3.5 shadow-raise">
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            className="accent-primary"
            checked={f.supportsTopology}
            onChange={(e) => set('supportsTopology', e.target.checked)}
          />
          <span className="text-[13px] font-[510] text-foreground">{t('topologyToggle')}</span>
        </label>
        {f.supportsTopology && (
          <div className="space-y-4 pl-[26px]">
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('traceSourceLabel')}>
                <Combobox
                  value={f.traceKind}
                  onChange={(v) => set('traceKind', v as 'otel' | 'mlflow')}
                  options={[
                    { value: 'otel', label: 'OTel' },
                    { value: 'mlflow', label: 'MLflow' },
                  ]}
                />
              </Field>
              <Field label={t('traceEndpointLabel')} hint={t('traceEndpointHint')}>
                <Input
                  value={f.traceEndpoint}
                  onChange={(e) => set('traceEndpoint', e.target.value)}
                  placeholder="http://mlflow.internal:5000"
                  autoComplete="off"
                />
              </Field>
            </div>
            <Field label={t('browserImageLabel')} hint={t('browserImageHint')}>
              <Input
                value={f.browserImage}
                onChange={(e) => set('browserImage', e.target.value)}
                placeholder="ghcr.io/acme/browser:latest"
                autoComplete="off"
              />
            </Field>
          </div>
        )}
      </div>

      {/* Common: description · tags */}
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('descriptionLabel')}>
          <Input
            value={f.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder={t('descriptionPlaceholder')}
            autoComplete="off"
          />
        </Field>
        <Field label={t('tagsLabel')} hint={t('commaSeparatedHint')}>
          <Input
            value={f.tags}
            onChange={(e) => set('tags', e.target.value)}
            placeholder="prod, gpu"
            autoComplete="off"
          />
        </Field>
      </div>

      {probe?.reachable !== undefined && (
        <Callout tone={probe.reachable ? 'info' : 'warning'}>
          {probe.reachable ? t('probeReachable') : t('probeUnreachable')}
          {probe.detail ? ` — ${probe.detail}` : ''}
        </Callout>
      )}
      {probe?.error && (
        <Callout tone="danger" className="py-1.5">
          {t('probeFailed', { error: probe.error })}
        </Callout>
      )}
      {validation &&
        (validation.ok ? (
          validation.missingSecrets && validation.missingSecrets.length > 0 ? (
            <Callout tone="warning">
              {t('missingSecrets', { names: validation.missingSecrets.join(', ') })}
            </Callout>
          ) : (
            <Callout tone="info">{t('validationOk')}</Callout>
          )
        ) : (
          <Callout tone="danger" className="py-1.5">
            {validation.errors && validation.errors.length > 0
              ? t('validationErrors', { errors: validation.errors.join('; ') })
              : t('validationFailed', { error: validation.error ?? '' })}
          </Callout>
        ))}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      <div className="flex items-center gap-2.5 border-t border-border pt-5">
        <Button onClick={onSubmit} disabled={saving} className="gap-1.5">
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <CheckCircle2 className="size-4" />
          )}
          {saving ? t('submitting') : editing ? t('saveEdit') : t('submit')}
        </Button>
        {cluster && (
          <Button variant="secondary" onClick={onProbe} disabled={probing} className="gap-1.5">
            {probing ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
            {t('probe')}
          </Button>
        )}
        {cluster && (
          <Button
            variant="secondary"
            onClick={onValidate}
            disabled={validating}
            className="gap-1.5"
          >
            {validating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ClipboardCheck className="size-4" />
            )}
            {t('validate')}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() =>
            router.push(
              editing
                ? `/${workspace}/runtimes/${encodeURIComponent(f.id)}`
                : `/${workspace}/runtimes`
            )
          }
        >
          {t('cancel')}
        </Button>
      </div>
    </div>
  )
}
