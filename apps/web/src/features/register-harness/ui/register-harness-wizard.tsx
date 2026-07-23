'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import type { PortabilityIssue } from '@everdict/contracts/wire'
import { ChevronDown, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { TopologyGraph } from '@/features/inspect-harness'
import type { HarnessSpec } from '@/entities/harness'
import { TraceSourceFields } from '@/entities/trace-source'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'
import { VersionField } from '@/shared/ui/version-field'

import {
  registerHarnessAction,
  registerHarnessTemplateAction,
  validateHarnessAction,
  validateHarnessTemplateAction,
  type RegisterHarnessResult,
  type ValidateHarnessResult,
} from '../api/register-harness'
import {
  buildInstance,
  buildTemplate,
  CONVENTIONAL_CONN_KEY,
  EMPTY_SERVICE_OVERRIDE,
  INITIAL_INSTANCE,
  INITIAL_TEMPLATE,
  isolateByForManagement,
  parseJsonObject,
  SERVICE_OS_OPTIONS,
  type DepInjectRow,
  type DepManagement,
  type DepRow,
  type InstanceState,
  type Kind,
  type PinRow,
  type ServiceOverrideRow,
  type ServiceRow,
  type TemplateState,
  type WiringRow,
} from '../lib/build-spec'
import { EnvEditor, type ScopedSecretNames } from './env-editor'
import { SpanMappingEditor } from './span-mapping-editor'

const EMPTY_SECRETS: ScopedSecretNames = { workspace: [], user: [] }

// Example hint for the front-door submit body value override editor (free-form JSON object).
const BODY_PLACEHOLDER = `{ "max_steps": 30, "system_prompt": "..." }`

// Catalog labels/descriptions can't be module-level constants (they need t), so they're built inside the component from an injected t (command-palette convention).
type Translate = ReturnType<typeof useTranslations>

const storeOptions = (t: Translate): ComboboxOption[] => [
  { value: 'postgres', description: t('storeRelationalDb') },
  { value: 'redis', description: t('storeInMemory') },
  { value: 'minio', description: t('storeObjectStore') },
]
// How the store is managed — the ONE comprehensible axis, replacing the raw 5-value isolateBy enum (which conflated
// physical partition mechanism [derived from the store, never a real choice], who-isolates, and deploy model). The
// physical schema/key-prefix/object-prefix values collapse into "managed"; the wizard derives them from the store kind.
const manageOptions = (t: Translate): ComboboxOption[] => [
  { value: 'managed', label: t('manageManagedLabel'), description: t('manageManagedDesc') },
  { value: 'agent', label: t('manageAgentLabel'), description: t('manageAgentDesc') },
  { value: 'external', label: t('manageExternalLabel'), description: t('manageExternalDesc') },
]
// The store's ROLE in the eval — the primary question (see docs/architecture/dependency-store-roles.md). Asking this
// first (instead of the raw isolateBy) means the author no longer needs to know their agent's internal isolation model.
const purposeOptions = (t: Translate): ComboboxOption[] => [
  { value: 'plumbing', label: t('purposePlumbingLabel'), description: t('purposePlumbingDesc') },
  { value: 'data', label: t('purposeDataLabel'), description: t('purposeDataDesc') },
]

// Per-service OS placement — the OS the image intrinsically needs (portable; the runtime maps it to a node). linux is
// the default (no gate); windows/macos exclude runtimes without such a node. SSOT for the values = SERVICE_OS_OPTIONS.
const osOptions = (t: Translate): ComboboxOption[] =>
  SERVICE_OS_OPTIONS.map((os) => ({
    value: os,
    label: os,
    description:
      os === 'linux'
        ? t('svcOsLinuxDesc')
        : os === 'windows'
          ? t('svcOsWindowsDesc')
          : t('svcOsMacosDesc'),
  }))

// kind = how the harness actually runs (runtime style). process is a harness defined in code,
// so a (declarative) form only yields an empty shell — excluded here; only command / service are exposed.
const kindOptions = (t: Translate): ComboboxOption[] => [
  {
    value: 'command',
    label: t('kindCommandLabel'),
    description: t('kindCommandDesc'),
  },
  {
    value: 'service',
    label: t('kindServiceLabel'),
    description: t('kindServiceDesc'),
  },
]

// category = a classification label for grouping in lists (kind decides how it runs — category has no effect on execution).
// Only the common ones per kind are exposed to narrow the choice.
const categoriesForKind = (k: Kind, t: Translate): ComboboxOption[] =>
  k === 'service'
    ? [
        { value: 'topology', label: 'topology', description: t('catTopologyDesc') },
        { value: 'custom', label: 'custom', description: t('catCustomDesc') },
      ]
    : [
        { value: 'cli-agent', label: 'cli-agent', description: t('catCliAgentDesc') },
        { value: 'claude-code', label: 'claude-code', description: t('catClaudeCodeDesc') },
        { value: 'codex', label: 'codex', description: t('catCodexDesc') },
        { value: 'desktop', label: 'desktop', description: t('catDesktopDesc') },
        { value: 'custom', label: 'custom', description: t('catCustomDesc') },
      ]

// Label + info tooltip (guidance is never inline — only on the info icon). Used for field descriptions across the registration form.
function FieldLabel({
  children,
  tip,
  htmlFor,
}: {
  children: React.ReactNode
  tip?: React.ReactNode
  htmlFor?: string
}) {
  return (
    <span className="flex items-center gap-1">
      <Label {...(htmlFor ? { htmlFor } : {})}>{children}</Label>
      {tip != null && <InfoTip content={tip} />}
    </span>
  )
}

// Version input — if existing is given, a semver bump dropdown (new=1.0.0); otherwise raw input (e.g. a reference tag).
function VersionRow({
  existing,
  value,
  onChange,
  rawLabel,
  rawId,
  placeholder,
}: {
  existing?: string[]
  value: string
  onChange: (v: string) => void
  rawLabel: React.ReactNode
  rawId: string
  placeholder: string
}) {
  if (existing) return <VersionField existing={existing} value={value} onChange={onChange} />
  return (
    <div className="space-y-1.5">
      <Label htmlFor={rawId}>{rawLabel}</Label>
      <Input
        id={rawId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}

type Tab = 'template' | 'instance'

export function RegisterHarnessWizard({
  secrets = EMPTY_SECRETS,
  modelIds = [],
}: {
  secrets?: ScopedSecretNames
  modelIds?: string[] // registered Model ids — offered as options for a command/service model binding
}) {
  const { workspace } = useParams<{ workspace: string }>()
  const t = useTranslations('registerHarness')
  const [tab, setTab] = useState<Tab>('template')

  return (
    <div className="max-w-2xl space-y-5">
      <div className="inline-flex rounded-md border border-border bg-secondary/50 p-0.5 text-[13px]">
        <TabBtn active={tab === 'template'} onClick={() => setTab('template')}>
          {t('tabTemplate')}
        </TabBtn>
        <TabBtn active={tab === 'instance'} onClick={() => setTab('instance')}>
          {t('tabInstance')}
        </TabBtn>
      </div>
      <p className="text-[12px] text-muted-foreground">
        {tab === 'template' ? t('tabTemplateHint') : t('tabInstanceHint')}
      </p>
      {tab === 'template' ? (
        <TemplateForm
          workspace={workspace}
          existingVersions={[]}
          secrets={secrets}
          modelIds={modelIds}
        />
      ) : (
        <InstanceForm workspace={workspace} existingVersions={[]} secrets={secrets} />
      )}
    </div>
  )
}

// --- Template (top-level category) registration ---
// initial prefill + lockId (a new shape version of the same top-level category — id/kind fixed) + onRegistered (on success the caller post-processes,
// e.g. moving to the instance tab that references the new version). Without onRegistered, the default is to move to the harness list.
export function TemplateForm({
  workspace,
  initial,
  lockId = false,
  onRegistered,
  existingVersions,
  secrets = EMPTY_SECRETS,
  modelIds = [],
}: {
  workspace: string
  initial?: TemplateState
  lockId?: boolean
  onRegistered?: (version: string) => void
  existingVersions?: string[]
  secrets?: ScopedSecretNames
  modelIds?: string[] // registered Model ids — options for the command/service model binding
}) {
  const router = useRouter()
  const t = useTranslations('registerHarness')
  const [s, setS] = useState<TemplateState>(initial ?? INITIAL_TEMPLATE)
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [result, setResult] = useState<ValidateHarnessResult>()
  const [regError, setRegError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const set = (patch: Partial<TemplateState>) => setS((prev) => ({ ...prev, ...patch }))
  const setService = (i: number, patch: Partial<ServiceRow>) =>
    set({ services: s.services.map((row, j) => (j === i ? { ...row, ...patch } : row)) })
  const setDep = (i: number, patch: Partial<DepRow>) =>
    set({ deps: s.deps.map((row, j) => (j === i ? { ...row, ...patch } : row)) })

  const spec = (): unknown => (mode === 'json' ? JSON.parse(jsonText) : buildTemplate(s))

  async function onValidate() {
    setBusy(true)
    setRegError(undefined)
    try {
      setResult(await validateHarnessTemplateAction(spec()))
    } catch {
      setResult({ ok: false, error: t('jsonParseFailed') })
    }
    setBusy(false)
  }
  async function onRegister() {
    setBusy(true)
    setRegError(undefined)
    let res: RegisterHarnessResult
    try {
      res = await registerHarnessTemplateAction(spec())
    } catch {
      setBusy(false)
      setRegError(t('jsonParseFailed'))
      return
    }
    setBusy(false)
    if (res.ok) {
      if (onRegistered) onRegistered(res.version ?? s.version)
      else router.push(`/${workspace}/harnesses`)
    } else setRegError(res.error ?? t('registerFailed'))
  }

  return (
    <div className="space-y-5">
      <ModeToggle
        mode={mode}
        setForm={() => setMode('form')}
        setJson={() => {
          setJsonText(JSON.stringify(buildTemplate(s), null, 2))
          setMode('json')
        }}
      />

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <FieldLabel
            tip={t.rich('kindTip', {
              b: (c) => <b>{c}</b>,
              br: () => <br />,
            })}
          >
            kind
          </FieldLabel>
          <Combobox
            value={s.kind}
            onChange={(v) =>
              set({
                kind: v as Kind,
                category: categoriesForKind(v as Kind, t)[0]?.value ?? 'custom',
              })
            }
            disabled={lockId}
            options={kindOptions(t)}
            className={cn('w-full', lockId && 'opacity-60')}
            aria-label="kind"
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel tip={t('categoryTip')}>category</FieldLabel>
          <Combobox
            value={s.category}
            onChange={(v) => set({ category: v })}
            options={categoriesForKind(s.kind, t)}
            className="w-full"
            aria-label="category"
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="tid" tip={t('idTip')}>
            id
          </FieldLabel>
          <Input
            id="tid"
            value={s.id}
            onChange={(e) => set({ id: e.target.value })}
            placeholder="bu"
            readOnly={lockId}
            className={cn(lockId && 'opacity-60')}
          />
        </div>
      </div>
      <VersionRow
        existing={existingVersions}
        value={s.version}
        onChange={(v) => set({ version: v })}
        rawLabel={t('versionRawLabel')}
        rawId="tver"
        placeholder="1"
      />

      {mode === 'form' && s.kind === 'service' && (
        <div className="space-y-6">
          <Section
            title={t('serviceSectionTitle')}
            tip={t.rich('serviceSectionTip', { b: (c) => <b>{c}</b> })}
            onAdd={() =>
              set({
                services: [
                  ...s.services,
                  {
                    name: '',
                    slot: '',
                    port: '',
                    needs: '',
                    perRun: '',
                    replicas: '1',
                    model: '',
                    env: [],
                    wiring: [],
                    volumes: '',
                    readinessTimeout: '',
                    readinessInterval: '',
                    os: '',
                  },
                ],
              })
            }
          >
            {s.services.map((sv, i) => (
              <div key={i} className="space-y-2.5 rounded-lg border bg-card p-3">
                <div className="grid grid-cols-2 gap-2.5">
                  <LabeledInput
                    label="name"
                    tip={t('svcNameTip')}
                    value={sv.name}
                    onChange={(v) => setService(i, { name: v })}
                    placeholder="agent-server"
                  />
                  <LabeledInput
                    label="slot"
                    tip={t('svcSlotTip')}
                    value={sv.slot}
                    onChange={(v) => setService(i, { slot: v })}
                    placeholder={t('svcSlotPlaceholder')}
                  />
                  <LabeledInput
                    label="port"
                    tip={t('svcPortTip')}
                    value={sv.port}
                    onChange={(v) => setService(i, { port: v })}
                    placeholder="8080"
                    inputMode="numeric"
                  />
                  <LabeledInput
                    label="replicas"
                    tip={t('svcReplicasTip')}
                    value={sv.replicas}
                    onChange={(v) => setService(i, { replicas: v })}
                    placeholder="1"
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-1">
                  <span className="flex items-center gap-1">
                    <span className="text-[11px] font-[510] text-muted-foreground">
                      {t('svcOsLabel')}
                    </span>
                    <InfoTip content={t('svcOsTip')} />
                  </span>
                  <Combobox
                    value={sv.os || 'linux'}
                    onChange={(v) => setService(i, { os: v })}
                    options={osOptions(t)}
                    className="w-full"
                    aria-label={t('svcOsLabel')}
                  />
                </div>
                <PeerNeedsField
                  tip={t('svcNeedsTip')}
                  value={sv.needs}
                  peers={s.services
                    .map((o) => o.name.trim())
                    .filter((n) => n && n !== sv.name.trim())}
                  onChange={(needs) => setService(i, { needs })}
                />
                <LabeledInput
                  label="perRun"
                  tip={t('svcPerRunTip')}
                  value={sv.perRun}
                  onChange={(v) => setService(i, { perRun: v })}
                  placeholder="thread_id"
                />
                <LabeledModel
                  label={t('svcModelLabel')}
                  tip={t('svcModelTip')}
                  value={sv.model}
                  onChange={(v) => setService(i, { model: v })}
                  options={modelIds}
                  placeholder="gpt-5.4-mini"
                />
                <EnvEditor
                  label="env"
                  tip={t.rich('svcEnvTip', { b: (c) => <b>{c}</b> })}
                  rows={sv.env}
                  onChange={(env) => setService(i, { env })}
                  secrets={secrets}
                />
                <PeerWiringEditor
                  rows={sv.wiring}
                  peers={s.services
                    .map((o) => o.name.trim())
                    .filter((n) => n && n !== sv.name.trim())}
                  onChange={(wiring) => setService(i, wiringPatch(sv, wiring))}
                />
                <LabeledTextarea
                  label="volumes"
                  tip={t('svcVolumesTip')}
                  value={sv.volumes}
                  onChange={(v) => setService(i, { volumes: v })}
                  placeholder="pgdata:/var/lib/postgresql/data"
                />
                <div className="grid grid-cols-2 gap-2.5">
                  <LabeledInput
                    label="readiness timeout (ms)"
                    tip={t('svcReadinessTimeoutTip')}
                    value={sv.readinessTimeout}
                    onChange={(v) => setService(i, { readinessTimeout: v })}
                    placeholder="60000"
                    inputMode="numeric"
                  />
                  <LabeledInput
                    label="readiness interval (ms)"
                    tip={t('svcReadinessIntervalTip')}
                    value={sv.readinessInterval}
                    onChange={(v) => setService(i, { readinessInterval: v })}
                    placeholder="1000"
                    inputMode="numeric"
                  />
                </div>
                {s.services.length > 1 && (
                  <RemoveBtn
                    onClick={() => set({ services: s.services.filter((_, j) => j !== i) })}
                  />
                )}
              </div>
            ))}
          </Section>
          <Section
            title={t('depSectionTitle')}
            tip={t.rich('depSectionTip', { b: (c) => <b>{c}</b> })}
            onAdd={() =>
              set({
                deps: [
                  ...s.deps,
                  {
                    store: 'postgres',
                    role: '',
                    purpose: 'plumbing',
                    management: 'managed',
                    service: '',
                    inject: [],
                  },
                ],
              })
            }
          >
            {s.deps.length === 0 && (
              <p className="text-[12px] text-muted-foreground">{t('none')}</p>
            )}
            {s.deps.map((d, i) => (
              <div key={i} className="space-y-2.5 rounded-lg border bg-card p-3">
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="space-y-1">
                    <span className="flex items-center gap-1">
                      <span className="text-[11px] font-[510] text-muted-foreground">
                        {t('depPurposeLabel')}
                      </span>
                      <InfoTip content={t('depPurposeTip')} />
                    </span>
                    <Combobox
                      value={d.purpose}
                      onChange={(v) => setDep(i, { purpose: v === 'data' ? 'data' : 'plumbing' })}
                      options={purposeOptions(t)}
                      className="w-full"
                      aria-label="purpose"
                    />
                  </div>
                  <div className="space-y-1">
                    <span className="flex items-center gap-1">
                      <span className="text-[11px] font-[510] text-muted-foreground">store</span>
                      <InfoTip content={t('depStoreTip')} />
                    </span>
                    <Combobox
                      value={d.store}
                      // isolateBy is derived from (management + store) at emit, so changing the store needs no extra work.
                      onChange={(v) => setDep(i, { store: v })}
                      options={storeOptions(t)}
                      className="w-full"
                      aria-label="store"
                    />
                  </div>
                  <LabeledInput
                    label="role"
                    tip={t('depRoleTip')}
                    value={d.role}
                    onChange={(v) => setDep(i, { role: v })}
                    placeholder="main"
                  />
                </div>
                <LabeledInput
                  label={t('depServiceLabel')}
                  tip={t('depServiceTip')}
                  value={d.service}
                  onChange={(v) => setDep(i, { service: v })}
                  placeholder="agent-server"
                />
                {d.purpose === 'data' && (
                  <p className="text-[11px] text-muted-foreground">{t('depDataNote')}</p>
                )}
                {/* The one comprehensible axis — who deploys the store & how cases are isolated. The physical mechanism
                    (schema/key-prefix/object-prefix) is derived from the store type, so it is never shown. */}
                <div className="space-y-1">
                  <span className="flex items-center gap-1">
                    <span className="text-[11px] font-[510] text-muted-foreground">
                      {t('depManageLabel')}
                    </span>
                    <InfoTip content={t('depManageTip')} />
                  </span>
                  <Combobox
                    value={d.management}
                    onChange={(v) => setDep(i, { management: v as DepManagement })}
                    options={manageOptions(t)}
                    className="w-full"
                    aria-label="management"
                  />
                </div>
                {d.management === 'external' ? (
                  <p className="text-[11px] text-muted-foreground">
                    {t('depExternalNote')}{' '}
                    {t.rich('depExternalHint', {
                      key: () => (
                        <code className="font-mono">
                          {CONVENTIONAL_CONN_KEY[d.store] ?? 'the store URL'}
                        </code>
                      ),
                      svc: () => <b>{d.service.trim() || t('depExternalHintAnyService')}</b>,
                    })}
                  </p>
                ) : (
                  <DepInjectEditor
                    rows={d.inject}
                    onChange={(inject) => setDep(i, { inject })}
                    store={d.store}
                  />
                )}
                <RemoveBtn onClick={() => set({ deps: s.deps.filter((_, j) => j !== i) })} />
              </div>
            ))}
          </Section>
          <div className="space-y-3">
            <h3 className="flex items-center gap-1 text-[13px] font-[560]">
              Front door
              <InfoTip content={t.rich('frontDoorTip', { b: (c) => <b>{c}</b> })} />
            </h3>
            <div className="grid grid-cols-3 gap-2.5">
              <LabeledInput
                label="service"
                tip={t('fdServiceTip')}
                value={s.frontDoorService}
                onChange={(v) => set({ frontDoorService: v })}
                placeholder="agent-server"
              />
              <LabeledInput
                label="submit"
                tip={t('fdSubmitTip')}
                value={s.frontDoorSubmit}
                onChange={(v) => set({ frontDoorSubmit: v })}
                placeholder="POST /runs"
              />
              <LabeledInput
                label={t('fdTraceLabel')}
                tip={t('fdTraceTip')}
                value={s.frontDoorTrace}
                onChange={(v) => set({ frontDoorTrace: v })}
                placeholder={t('optionalPlaceholder')}
              />
            </div>
          </div>
          <div className="space-y-3">
            <h3 className="flex items-center gap-1 text-[13px] font-[560]">
              Trace source
              <InfoTip content={t('traceSourceTip')} />
            </h3>
            <TraceSourceFields
              value={s.traceSource}
              onChange={(patch) => set({ traceSource: { ...s.traceSource, ...patch } })}
            />
            <SpanMappingEditor
              mapping={s.traceMapping}
              onChange={(traceMapping) => set({ traceMapping })}
            />
          </div>
          <TopologyPreview s={s} />
        </div>
      )}

      {mode === 'form' && s.kind === 'command' && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2.5">
            <LabeledInput
              label={t('imageLabel')}
              tip={t('imageTip')}
              value={s.image}
              onChange={(v) => set({ image: v })}
              placeholder="ghcr.io/…"
            />
            <LabeledModel
              label={t('modelLabel')}
              tip={
                <>
                  {t('modelTipPre')} {'{{model}}'} {t('modelTipPost')}
                </>
              }
              value={s.model}
              onChange={(v) => set({ model: v })}
              options={modelIds}
              placeholder="claude-opus-4-8"
            />
            <LabeledInput
              label={t('workDirLabel')}
              tip={t('workDirTip')}
              value={s.workDir}
              onChange={(v) => set({ workDir: v })}
              placeholder="/tmp"
            />
          </div>
          <div className="space-y-1">
            <FieldLabel
              tip={
                <>
                  {t.rich('commandTipPre', { b: (c) => <b>{c}</b> })} <code>{'{{task}}'}</code>·
                  <code>{'{{model}}'}</code>·<code>{'{{run_id}}'}</code> {t('commandTipPost')}
                </>
              }
            >
              {t('commandLabel')}
            </FieldLabel>
            <Input
              aria-label="command"
              value={s.command}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="aider --message {{task}} --model {{model}} ."
            />
          </div>
          <LabeledTextarea
            label={t('setupLabel')}
            tip={t('setupTip')}
            value={s.setup}
            onChange={(v) => set({ setup: v })}
            placeholder="pip install aider-chat"
          />
          <EnvEditor
            label={t('envOptionalLabel')}
            tip={t.rich('cmdEnvTip', { b: (c) => <b>{c}</b> })}
            rows={s.envRows}
            onChange={(envRows) => set({ envRows })}
            secrets={secrets}
          />
        </div>
      )}

      {mode === 'json' && (
        <JsonArea label="HarnessTemplateSpec (JSON)" value={jsonText} onChange={setJsonText} />
      )}
      {mode === 'form' && <JsonPreview value={buildTemplate(s)} />}

      {result && <ValidateBanner result={result} />}
      {regError && <Callout tone="danger">{regError}</Callout>}
      <Actions
        busy={busy}
        onValidate={onValidate}
        onRegister={onRegister}
        registerLabel={t('registerTemplateLabel')}
      />
    </div>
  )
}

// Per-slot label description/example — on the edit screen where slots are fixed by the template, shows "what this pin is" up front.
// command has two fixed slots, image·model; for service the slot name is the service name.
function pinGuide(slot: string, t: Translate): { hint: string; placeholder: string } {
  if (slot === 'image') return { hint: t('pinImageHint'), placeholder: 'ghcr.io/acme/codex:pr-12' }
  if (slot === 'model') return { hint: t('pinModelHint'), placeholder: 'claude-opus-4-8' }
  return { hint: t('pinServiceHint', { slot }), placeholder: 'ghcr.io/acme/agent:abc' }
}

// --- Instance (template + pins) registration ---
// initial prefill + lockId (a new version of the same harness — id fixed) + redirectDetailId (return to detail on success).
export function InstanceForm({
  workspace,
  initial,
  lockId = false,
  redirectDetailId,
  existingVersions,
  secrets = EMPTY_SECRETS,
  kind,
}: {
  workspace: string
  initial?: InstanceState
  lockId?: boolean
  redirectDetailId?: string
  existingVersions?: string[]
  secrets?: ScopedSecretNames
  // The kind of the template this instance rides on — if known, only the overrides block matching that kind is exposed (edit screen).
  // If the kind is unknown (like the new-instance wizard), undefined → all blocks exposed (backward compatible).
  kind?: Kind
}) {
  const router = useRouter()
  const t = useTranslations('registerHarness')
  const [s, setS] = useState<InstanceState>(initial ?? INITIAL_INSTANCE)
  const [result, setResult] = useState<ValidateHarnessResult>()
  const [regError, setRegError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const set = (patch: Partial<InstanceState>) => setS((prev) => ({ ...prev, ...patch }))
  const setPin = (i: number, patch: Partial<PinRow>) =>
    set({ pins: s.pins.map((row, j) => (j === i ? { ...row, ...patch } : row)) })
  const setSvcOv = (i: number, patch: Partial<ServiceOverrideRow>) =>
    set({
      serviceOverrides: s.serviceOverrides.map((row, j) => (j === i ? { ...row, ...patch } : row)),
    })

  // front-door body JSON parse state — on error, block validate/register (don't send invalid JSON to the control plane).
  const bodyParse = parseJsonObject(s.bodyTemplate)
  // build-spec returns an error code — translated here with t() (anything else passes through as the engine's original message).
  const rawBodyError = bodyParse.ok ? undefined : bodyParse.error
  const bodyError =
    rawBodyError === 'invalidJson'
      ? t('invalidJson')
      : rawBodyError === 'notObject'
        ? t('notObject')
        : rawBodyError

  async function onValidate() {
    if (bodyError) return setRegError(t('bodyJsonError', { error: bodyError }))
    setBusy(true)
    setRegError(undefined)
    setResult(await validateHarnessAction(buildInstance(s)))
    setBusy(false)
  }
  async function onRegister() {
    if (bodyError) return setRegError(t('bodyJsonError', { error: bodyError }))
    setBusy(true)
    setRegError(undefined)
    const res = await registerHarnessAction(buildInstance(s))
    setBusy(false)
    if (res.ok) {
      // If a new version (redirectDetailId), go to that version's detail; otherwise the list.
      router.push(
        redirectDetailId
          ? `/${workspace}/harnesses/${encodeURIComponent(redirectDetailId)}?v=${encodeURIComponent(res.version ?? s.version)}`
          : `/${workspace}/harnesses`
      )
    } else setRegError(res.error ?? t('registerFailed'))
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="itid" tip={t('templateIdTip')}>
            template id
          </FieldLabel>
          <Input
            id="itid"
            value={s.templateId}
            onChange={(e) => set({ templateId: e.target.value })}
            placeholder="bu"
            readOnly={lockId}
            className={cn(lockId && 'opacity-60')}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="itver" tip={t('templateVersionTip')}>
            template version
          </FieldLabel>
          <Input
            id="itver"
            value={s.templateVersion}
            onChange={(e) => set({ templateVersion: e.target.value })}
            placeholder="1"
          />
        </div>
      </div>
      <VersionRow
        existing={existingVersions}
        value={s.version}
        onChange={(v) => set({ version: v })}
        rawLabel="instance version"
        rawId="iver"
        placeholder="pr-123-sha-abc"
      />

      <div className="space-y-1.5">
        <FieldLabel htmlFor="idesc" tip={t('descriptionTip')}>
          {t('changeLogLabel')}
        </FieldLabel>
        <Textarea
          id="idesc"
          value={s.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder={t('descriptionPlaceholder')}
          rows={2}
        />
      </div>

      {kind === 'command' || kind === 'service' ? (
        // When slots are fixed by the template (edit screen) — slot label + one-line description + value only. No slot editing/add/delete.
        <Section
          title={t('pinsFixedTitle')}
          tip={kind === 'command' ? t('pinsCommandTip') : t('pinsServiceTip')}
        >
          {s.pins.map((p, i) => {
            const g = pinGuide(p.slot, t)
            return (
              <div key={i} className="space-y-1.5 rounded-lg border bg-card p-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[13px] font-[560] text-foreground">{p.slot}</span>
                  <span className="text-[12px] text-muted-foreground">{g.hint}</span>
                </div>
                <Input
                  value={p.value}
                  onChange={(e) => setPin(i, { value: e.target.value })}
                  placeholder={g.placeholder}
                  aria-label={t('pinValueAria', { slot: p.slot })}
                />
              </div>
            )
          })}
        </Section>
      ) : (
        // New-instance wizard — kind/slots not yet known, so free input (type the slot directly) + add/delete.
        <Section
          title={t('pinsFreeTitle')}
          onAdd={() => set({ pins: [...s.pins, { slot: '', value: '' }] })}
        >
          {s.pins.map((p, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border bg-card p-3">
              <Input
                value={p.slot}
                onChange={(e) => setPin(i, { slot: e.target.value })}
                placeholder="slot (agent-server / image / model)"
              />
              <Input
                value={p.value}
                onChange={(e) => setPin(i, { value: e.target.value })}
                placeholder="value (ghcr.io/…/agent:abc)"
              />
              {s.pins.length > 1 && (
                <RemoveBtn onClick={() => set({ pins: s.pins.filter((_, j) => j !== i) })} />
              )}
            </div>
          ))}
        </Section>
      )}

      <OverridesEditor
        s={s}
        set={set}
        setSvcOv={setSvcOv}
        bodyError={bodyError}
        secrets={secrets}
        kind={kind}
      />

      <JsonPreview value={buildInstance(s)} />
      {result && <ValidateBanner result={result} />}
      {regError && <Callout tone="danger">{regError}</Callout>}
      <p className="text-[12px] text-muted-foreground">{t('instanceHint')}</p>
      <Actions
        busy={busy}
        onValidate={onValidate}
        onRegister={onRegister}
        registerLabel={t('registerInstanceLabel')}
      />
    </div>
  )
}

// overrides structured editor — a delta that changes only behavior on top of the same template. It's optional, so it's hidden in a disclosure
// to keep the default form (image pin) clean; only those who need it expand it. If existing overrides are present (editing a new version), auto-expand.
function hasOverrides(s: InstanceState): boolean {
  return (
    s.serviceOverrides.length > 0 ||
    s.bodyTemplate.trim() !== '' ||
    s.completionTimeout.trim() !== '' ||
    s.completionInterval.trim() !== '' ||
    s.targetExtensionRef.trim() !== '' ||
    s.cmdEnvRows.length > 0 ||
    s.cmdParams.trim() !== ''
  )
}

function OverridesEditor({
  s,
  set,
  setSvcOv,
  bodyError,
  secrets,
  kind,
}: {
  s: InstanceState
  set: (patch: Partial<InstanceState>) => void
  setSvcOv: (i: number, patch: Partial<ServiceOverrideRow>) => void
  bodyError?: string
  secrets: ScopedSecretNames
  kind?: Kind
}) {
  const t = useTranslations('registerHarness')
  const [open, setOpen] = useState(hasOverrides(s))
  // If the kind is known, expose only that kind's overrides: command→Command block only, service→service/front-door/target only.
  // If unknown (undefined, e.g. the new-instance wizard), expose all (backward compatible).
  const showService = kind !== 'command'
  const showCommand = kind !== 'service'
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-secondary/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50"
      >
        <span className="flex items-center gap-2 text-[13px] font-[560] text-foreground">
          <SlidersHorizontal className="size-3.5 text-muted-foreground" />
          {t('overridesTitle')}
          <span className="font-normal text-[12px] text-muted-foreground">
            {t('overridesSubtitle')}
          </span>
        </span>
        <ChevronDown
          className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="space-y-6 border-t border-border px-4 py-4">
          {showService && (
            <>
              <Section
                title={t('svcOverrideTitle')}
                onAdd={() =>
                  set({ serviceOverrides: [...s.serviceOverrides, { ...EMPTY_SERVICE_OVERRIDE }] })
                }
              >
                {s.serviceOverrides.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">{t('svcOverrideEmpty')}</p>
                ) : (
                  s.serviceOverrides.map((r, i) => (
                    <div key={i} className="space-y-2.5 rounded-lg border bg-card p-3">
                      <div className="flex items-center gap-2">
                        <Input
                          value={r.service}
                          onChange={(e) => setSvcOv(i, { service: e.target.value })}
                          placeholder={t('svcNamePlaceholder')}
                        />
                        <RemoveBtn
                          onClick={() =>
                            set({ serviceOverrides: s.serviceOverrides.filter((_, j) => j !== i) })
                          }
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <NumField
                          label="replicas"
                          value={r.replicas}
                          onChange={(v) => setSvcOv(i, { replicas: v })}
                          placeholder="2"
                        />
                        <NumField
                          label={t('cpuLabel')}
                          value={r.cpu}
                          onChange={(v) => setSvcOv(i, { cpu: v })}
                          placeholder="2000"
                        />
                        <NumField
                          label="memory (MB)"
                          value={r.memoryMb}
                          onChange={(v) => setSvcOv(i, { memoryMb: v })}
                          placeholder="4096"
                        />
                      </div>
                      <EnvEditor
                        label="env"
                        tip={t.rich('svcOverrideEnvTip', { b: (c) => <b>{c}</b> })}
                        rows={r.env}
                        onChange={(env) => setSvcOv(i, { env })}
                        secrets={secrets}
                      />
                      <Textarea
                        value={r.volumes}
                        onChange={(e) => setSvcOv(i, { volumes: e.target.value })}
                        placeholder={t('volumesOverridePlaceholder')}
                        rows={2}
                        className="font-mono text-[12px]"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <NumField
                          label="readiness timeout (ms)"
                          value={r.readinessTimeout}
                          onChange={(v) => setSvcOv(i, { readinessTimeout: v })}
                          placeholder="60000"
                        />
                        <NumField
                          label="readiness interval (ms)"
                          value={r.readinessInterval}
                          onChange={(v) => setSvcOv(i, { readinessInterval: v })}
                          placeholder="1000"
                        />
                      </div>
                    </div>
                  ))
                )}
              </Section>

              <OvBlock title={t('fdOverrideTitle')}>
                <div className="space-y-1.5">
                  <Label htmlFor="ovbody">{t('bodyTemplateLabel')}</Label>
                  <Textarea
                    id="ovbody"
                    value={s.bodyTemplate}
                    onChange={(e) => set({ bodyTemplate: e.target.value })}
                    placeholder={BODY_PLACEHOLDER}
                    rows={3}
                    className="font-mono text-[12px]"
                  />
                  {bodyError && (
                    <Callout tone="danger">{t('bodyJsonInline', { error: bodyError })}</Callout>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <NumField
                    label={t('completionTimeoutLabel')}
                    value={s.completionTimeout}
                    onChange={(v) => set({ completionTimeout: v })}
                    placeholder="120000"
                  />
                  <NumField
                    label={t('completionIntervalLabel')}
                    value={s.completionInterval}
                    onChange={(v) => set({ completionInterval: v })}
                    placeholder="1000"
                  />
                </div>
              </OvBlock>

              <OvBlock title={t('targetOverrideTitle')}>
                <div className="space-y-1.5">
                  <Label htmlFor="ovext">{t('extensionRefLabel')}</Label>
                  <Input
                    id="ovext"
                    value={s.targetExtensionRef}
                    onChange={(e) => set({ targetExtensionRef: e.target.value })}
                    placeholder="ghcr.io/acme/ext:2"
                  />
                </div>
              </OvBlock>
            </>
          )}

          {showCommand && (
            <OvBlock title={t('cmdOverrideTitle')}>
              <EnvEditor
                label="env"
                tip={t.rich('cmdOverrideEnvTip', { b: (c) => <b>{c}</b> })}
                rows={s.cmdEnvRows}
                onChange={(cmdEnvRows) => set({ cmdEnvRows })}
                secrets={secrets}
              />
              <div className="space-y-1.5">
                <Label htmlFor="ovcmdparams">
                  {'params — command {{var}} '}
                  {t('paramsValueLabel')}
                </Label>
                <Textarea
                  id="ovcmdparams"
                  value={s.cmdParams}
                  onChange={(e) => set({ cmdParams: e.target.value })}
                  placeholder="edit_format=diff"
                  rows={2}
                  className="font-mono text-[12px]"
                />
              </div>
            </OvBlock>
          )}
        </div>
      )}
    </div>
  )
}

// Small label + numeric input (the form stores strings — reduced via Number()). Repeated per row, so aria-label instead of an id (no id collisions).
function NumField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <Input
        inputMode="numeric"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}

// Override sub-group card — faint title + content.
function OvBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <h4 className="text-[12px] font-[560] text-muted-foreground">{title}</h4>
      {children}
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-3 py-1 font-[510] transition-colors',
        active
          ? 'bg-card text-foreground shadow-raise'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function ModeToggle({
  mode,
  setForm,
  setJson,
}: {
  mode: 'form' | 'json'
  setForm: () => void
  setJson: () => void
}) {
  const t = useTranslations('registerHarness')
  return (
    <div className="inline-flex rounded-md border border-border bg-secondary/50 p-0.5 text-[13px]">
      <TabBtn active={mode === 'form'} onClick={setForm}>
        {t('modeForm')}
      </TabBtn>
      <TabBtn active={mode === 'json'} onClick={setJson}>
        JSON
      </TabBtn>
    </div>
  )
}

function JsonArea({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const t = useTranslations('registerHarness')
  return (
    <div className="space-y-1.5">
      <Label htmlFor="json">{label}</Label>
      <Textarea
        id="json"
        className="min-h-72 text-[12px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <p className="text-[12px] text-muted-foreground">{t('jsonModeNote')}</p>
    </div>
  )
}

function JsonPreview({ value }: { value: unknown }) {
  const t = useTranslations('registerHarness')
  return (
    <details className="rounded-lg border bg-muted/40 p-3 text-[13px]">
      <summary className="cursor-pointer font-[510] text-foreground">{t('jsonPreview')}</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-card p-2 font-mono text-[12px] text-muted-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
}

function Actions({
  busy,
  onValidate,
  onRegister,
  registerLabel,
}: {
  busy: boolean
  onValidate: () => void
  onRegister: () => void
  registerLabel: string
}) {
  const t = useTranslations('registerHarness')
  return (
    <div className="flex gap-2">
      <Button type="button" variant="secondary" onClick={onValidate} disabled={busy}>
        {busy ? '…' : t('validateLabel')}
      </Button>
      <Button type="button" onClick={onRegister} disabled={busy}>
        {busy ? t('processingLabel') : registerLabel}
      </Button>
    </div>
  )
}

function Section({
  title,
  tip,
  onAdd,
  children,
}: {
  title: string
  tip?: React.ReactNode
  onAdd?: () => void // if absent, the 'add' button is hidden (a section where rows can't grow, like fixed slots)
  children: React.ReactNode
}) {
  const t = useTranslations('registerHarness')
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1 text-[13px] font-[560] text-foreground">
          {title}
          {tip != null && <InfoTip content={tip} />}
        </h3>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            className="flex items-center gap-1 text-[12px] font-[510] text-link transition-colors hover:text-foreground"
          >
            <Plus className="size-3.5" /> {t('add')}
          </button>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

// Labeled model picker — a combobox over the workspace's registered Model ids (a free-typed value is still surfaced
// verbatim, so an unregistered literal keeps working). The chosen id resolves to its connection env at dispatch.
function LabeledModel({
  label,
  tip,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string
  tip?: React.ReactNode
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <FieldLabel tip={tip}>{label}</FieldLabel>
      <Combobox
        value={value}
        onChange={onChange}
        options={options.map((id) => ({ value: id }))}
        {...(placeholder ? { placeholder } : {})}
        aria-label={label}
      />
    </div>
  )
}

// Text input with a small label + info tooltip (guides "what's what" where fields are dense, like service rows).
function LabeledInput({
  label,
  tip,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: string
  tip?: React.ReactNode
  value: string
  onChange: (v: string) => void
  placeholder?: string
  inputMode?: 'numeric'
}) {
  return (
    <div className="space-y-1">
      <span className="flex items-center gap-1">
        <span className="text-[11px] font-[510] text-muted-foreground">{label}</span>
        {tip != null && <InfoTip content={tip} />}
      </span>
      <Input
        {...(inputMode ? { inputMode } : {})}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(placeholder ? { placeholder } : {})}
      />
    </div>
  )
}

// Multi-line input with a small label + info tooltip (for line-based values like env·volumes).
function LabeledTextarea({
  label,
  tip,
  value,
  onChange,
  placeholder,
}: {
  label: string
  tip?: React.ReactNode
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <span className="flex items-center gap-1">
        <span className="text-[11px] font-[510] text-muted-foreground">{label}</span>
        {tip != null && <InfoTip content={tip} />}
      </span>
      <Textarea
        className="min-h-14 text-[12px]"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(placeholder ? { placeholder } : {})}
      />
    </div>
  )
}

// A wiring change also keeps each referenced peer in `needs` (never auto-removes): the portability lint requires a
// wired peer to be a declared need, so the editor maintains that invariant for the author.
function wiringPatch(sv: ServiceRow, wiring: WiringRow[]): Partial<ServiceRow> {
  const needs = new Set(
    sv.needs
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  )
  for (const w of wiring) {
    const svc = w.service.trim()
    if (svc) needs.add(svc)
  }
  return { wiring, needs: [...needs].join(', ') }
}

// needs (peer edges) as a toggle-chip multiselect over the OTHER declared services — you can only pick a declared
// peer, so its address is always resolvable per runtime (portable by construction, no typed "db:5432"). A stale need
// (a service since renamed/removed) shows as a struck-through chip that can be cleared.
function PeerNeedsField({
  value,
  peers,
  onChange,
  tip,
}: {
  value: string
  peers: string[]
  onChange: (needs: string) => void
  tip?: React.ReactNode
}) {
  const t = useTranslations('registerHarness')
  const current = value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const set = new Set(current)
  const toggle = (name: string) => {
    const next = new Set(current)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    onChange([...next].join(', '))
  }
  const stale = current.filter((n) => !peers.includes(n))
  return (
    <div className="space-y-1">
      <span className="flex items-center gap-1">
        <span className="text-[11px] font-[510] text-muted-foreground">needs</span>
        {tip != null && <InfoTip content={tip} />}
      </span>
      {peers.length === 0 && stale.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{t('needsNoPeers')}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {peers.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              aria-pressed={set.has(name)}
              className={cn(
                'rounded-md px-2 py-0.5 text-[12px] font-[510] ring-1 ring-inset transition-colors',
                set.has(name)
                  ? 'bg-primary/12 text-[var(--color-accent-foreground)] ring-primary/25'
                  : 'bg-secondary text-muted-foreground ring-border hover:text-foreground'
              )}
            >
              {name}
            </button>
          ))}
          {stale.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              title={t('needsStaleTip')}
              className="rounded-md bg-transparent px-2 py-0.5 text-[12px] text-muted-foreground line-through ring-1 ring-inset ring-border hover:text-destructive"
            >
              {name} ✕
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Peer wiring — the portable way to hand a service its peer's address: pick a declared peer and name the env var(s)
// that receive its host/port/url; the runtime fills the per-backend address at deploy. Selecting a peer keeps it in
// needs (wiringPatch). For freeform composite URLs, an env value may instead use a {{peer.url}} token (env editor).
function PeerWiringEditor({
  rows,
  peers,
  onChange,
}: {
  rows: WiringRow[]
  peers: string[]
  onChange: (rows: WiringRow[]) => void
}) {
  const t = useTranslations('registerHarness')
  const setRow = (i: number, patch: Partial<WiringRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const add = () =>
    onChange([...rows, { service: peers[0] ?? '', hostEnv: '', portEnv: '', urlEnv: '' }])
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1">
          <span className="text-[11px] font-[510] text-muted-foreground">{t('wiringLabel')}</span>
          <InfoTip
            content={t.rich('wiringTip', { b: (c) => <b>{c}</b>, code: (c) => <code>{c}</code> })}
          />
        </span>
        <button
          type="button"
          onClick={add}
          disabled={peers.length === 0}
          className="flex items-center gap-1 text-[12px] font-[510] text-link transition-colors hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-3.5" /> {t('add')}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {peers.length === 0 ? t('wiringNoPeers') : t('wiringEmpty')}
        </p>
      ) : (
        rows.map((r, i) => (
          <div key={i} className="space-y-2 rounded-md border bg-muted/30 p-2.5">
            <div className="flex items-center gap-2">
              <Combobox
                value={r.service}
                onChange={(v) => setRow(i, { service: v })}
                options={peers.map((p) => ({ value: p }))}
                className="w-44"
                aria-label={t('wiringPeerAria')}
                placeholder={t('wiringPeerPlaceholder')}
              />
              <RemoveBtn onClick={() => onChange(rows.filter((_, j) => j !== i))} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <WiringEnvField
                label={t('wiringUrlEnv')}
                value={r.urlEnv}
                onChange={(v) => setRow(i, { urlEnv: v })}
                placeholder="API_BASE_URL"
              />
              <WiringEnvField
                label={t('wiringHostEnv')}
                value={r.hostEnv}
                onChange={(v) => setRow(i, { hostEnv: v })}
                placeholder="DB_HOST"
              />
              <WiringEnvField
                label={t('wiringPortEnv')}
                value={r.portEnv}
                onChange={(v) => setRow(i, { portEnv: v })}
                placeholder="DB_PORT"
              />
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function WiringEnvField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <Input
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-[12px]"
      />
    </div>
  )
}

// Live topology preview — the same read-only graph the harness detail shows, fed from the in-progress form state so
// authors SEE the structure (services · needs edges · stores · front-door · target) form as they type. Image-less
// (pins come later); the graph never reads image. Named services only (an unnamed row is noise).
function previewSpec(s: TemplateState): HarnessSpec {
  return {
    kind: 'service',
    id: s.id.trim() || 'preview',
    version: s.version.trim() || '1',
    services: s.services
      .filter((sv) => sv.name.trim())
      .map((sv) => ({
        name: sv.name.trim(),
        image: '',
        ...(sv.port.trim() ? { port: Number(sv.port) } : {}),
        needs: sv.needs
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        perRun: [],
        replicas: sv.replicas.trim() ? Number(sv.replicas) : 1,
        env: {},
        // Only a non-linux OS is a real placement requirement (linux = default) — mirror the emit rule so the badge shows live.
        ...(sv.os.trim() && sv.os.trim() !== 'linux' ? { requires: { os: sv.os.trim() } } : {}),
      })),
    dependencies: s.deps
      .filter((d) => d.store.trim())
      .map((d) => {
        // Mirror the emit rule (external deps carry no inject) so the store edge labels the BYO keys live.
        const inject =
          d.management === 'external'
            ? []
            : d.inject.filter((m) => m.env.trim()).map((m) => ({ env: m.env.trim() }))
        return {
          store: d.store,
          role: d.role,
          purpose: d.purpose, // always present for the live diagram's (required) local type
          isolateBy: isolateByForManagement(d.management, d.store),
          ...(d.service.trim() ? { service: d.service.trim() } : {}),
          ...(inject.length ? { inject } : {}),
        }
      }),
    ...(s.targetEnabled ? { target: { kind: 'browser', observe: [] } } : {}),
    frontDoor: { service: s.frontDoorService, submit: s.frontDoorSubmit },
    traceSource: { kind: s.traceSource.kind, endpoint: s.traceSource.endpoint },
  }
}

function TopologyPreview({ s }: { s: TemplateState }) {
  const t = useTranslations('registerHarness')
  const named = s.services.filter((sv) => sv.name.trim())
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-1 text-[13px] font-[560] text-foreground">
        {t('previewTitle')}
        <InfoTip content={t('previewTip')} />
      </h3>
      {named.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{t('previewEmpty')}</p>
      ) : (
        <TopologyGraph spec={previewSpec(s)} />
      )}
    </div>
  )
}

// The {field} vocabulary an inject template can recompose, per store kind (mirror of the control plane's
// STORE_INJECT_FIELDS — display hint only; the control plane rejects an unknown field at registration).
const INJECT_FIELD_HINT: Record<string, string> = {
  postgres: '{host} {port} {endpoint} {url} {user} {password} {userinfo} {database}',
  redis: '{host} {port} {endpoint} {url} {user} {password} {userinfo} {keyPrefix}',
  minio: '{host} {port} {endpoint} {url} {accessKey} {secretKey} {bucket}',
}

// BYO store env names (dependencies[].inject) — the store-side sibling of the peer wiring editor: the image reads its
// store connection under ITS OWN keys (VALKEY_URL …), rendered at deploy time from the store Everdict actually
// deploys. Empty template = the store's canonical {url}.
function DepInjectEditor({
  rows,
  onChange,
  store,
}: {
  rows: DepInjectRow[]
  onChange: (rows: DepInjectRow[]) => void
  store: string
}) {
  const t = useTranslations('registerHarness')
  const set = (i: number, patch: Partial<DepInjectRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1">
          <span className="text-[11px] font-[510] text-muted-foreground">
            {t('depInjectLabel')}
          </span>
          <InfoTip
            content={
              <>
                {t('depInjectTip')}{' '}
                <code className="font-mono">{INJECT_FIELD_HINT[store] ?? ''}</code>
              </>
            }
          />
        </span>
        <button
          type="button"
          onClick={() => onChange([...rows, { env: '', template: '' }])}
          className="flex items-center gap-1 text-[12px] font-[510] text-link transition-colors hover:text-foreground"
        >
          <Plus className="size-3.5" /> {t('depInjectAdd')}
        </button>
      </div>
      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={t('depInjectEnvLabel')}
                value={r.env}
                onChange={(e) => set(i, { env: e.target.value })}
                placeholder="VALKEY_URL"
                spellCheck={false}
                className="w-2/5 font-mono text-[12px]"
              />
              <Input
                aria-label={t('depInjectTemplateLabel')}
                value={r.template}
                onChange={(e) => set(i, { template: e.target.value })}
                placeholder={t('depInjectTemplatePlaceholder')}
                spellCheck={false}
                className="flex-1 font-mono text-[12px]"
              />
              <button
                type="button"
                aria-label={t('remove')}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
                className="text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  const t = useTranslations('registerHarness')
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-destructive"
    >
      <Trash2 className="size-3.5" /> {t('remove')}
    </button>
  )
}

function ValidateBanner({ result }: { result: ValidateHarnessResult }) {
  const t = useTranslations('registerHarness')
  const issues = result.portabilityIssues ?? []
  return (
    <div className="space-y-2">
      {result.error ? (
        <Callout tone="danger">{t('validateRunFailed', { error: result.error })}</Callout>
      ) : !result.ok ? (
        <Callout tone="danger">
          <div className="font-[560]">{t('validateFailed')}</div>
          <ul className="mt-1 list-disc pl-5">
            {result.errors?.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Callout>
      ) : (
        <Callout tone="info">
          <div className="font-[560]">
            {t('validatePassed')} {result.kind ? `${result.kind} ` : ''}
            {result.id}@{result.version}
          </div>
          {result.existingVersions !== undefined && (
            <div className="mt-1 text-[12px] text-muted-foreground">
              {t('existingVersionsLabel')}{' '}
              {result.existingVersions.length > 0 ? result.existingVersions.join(', ') : t('none')}
              {result.versionExists && ` — ${t('versionExistsNote')}`}
            </div>
          )}
          {/* Image provenance warning — locally built/unqualified images can't be pulled from another runtime (registration is still allowed). */}
          {result.imageWarnings && result.imageWarnings.length > 0 && (
            <div className="mt-1 text-[12px] text-muted-foreground">
              {t('imageWarningsLabel')}{' '}
              {result.imageWarnings.map((w) => (
                <code key={w.image} className="mr-1 font-mono">
                  {w.image}(
                  {w.class === 'local' ? t('imageClassLocal') : t('imageClassUnqualified')})
                </code>
              ))}
              — <code className="font-mono">everdict image push</code> {t('imagePushHint')}
            </div>
          )}
        </Callout>
      )}
      {issues.length > 0 && <PortabilityIssues issues={issues} />}
    </div>
  )
}

// Cross-runtime portability findings, anchored to the offending service/field (not a raw error blob). Errors mean a
// service instance built on this template will be hard-blocked at registration (address differs per runtime); warnings
// are migratable host literals. Ordered errors-first.
function PortabilityIssues({ issues }: { issues: PortabilityIssue[] }) {
  const t = useTranslations('registerHarness')
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  return (
    <Callout tone={errors.length > 0 ? 'danger' : 'warning'}>
      <div className="font-[560]">
        {errors.length > 0 ? t('portabilityErrorsTitle') : t('portabilityWarningsTitle')}
      </div>
      <p className="mt-0.5 text-[12px] text-muted-foreground">{t('portabilityHint')}</p>
      <ul className="mt-2 space-y-1.5">
        {[...errors, ...warnings].map((issue, idx) => (
          <li key={`${issue.field}-${idx}`} className="flex items-start gap-2 text-[12px]">
            <Badge tone={issue.severity === 'error' ? 'danger' : 'warning'}>
              {issue.severity === 'error' ? t('severityError') : t('severityWarning')}
            </Badge>
            <div className="min-w-0">
              <code className="font-mono text-[11px] text-foreground">
                {issue.service ? `${issue.service} · ` : ''}
                {issue.field}
              </code>
              <p className="text-muted-foreground">{issue.message}</p>
            </div>
          </li>
        ))}
      </ul>
    </Callout>
  )
}
