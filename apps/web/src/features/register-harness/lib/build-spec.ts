// Assemble wizard form state → HarnessTemplateSpec / HarnessInstanceSpec (pure). The control plane does the final schema/conflict validation.
// Template (top-level category) = shape/slots (version not pinned); Instance = template reference + pins (slot→image/value).
import type { SpanAttrMapping } from '@everdict/contracts'

import type { HarnessTemplateSpec } from '@/entities/harness'
import { traceSourceToSpec, type TraceSourceValue } from '@/entities/trace-source'

export type Kind = 'process' | 'service' | 'command'

// Peer wiring row — inject a needs-peer's resolved address into this service's env under BYO variable names. The
// portable alternative to a hardcoded host: the runtime fills the per-backend address, so a spec never bakes in
// "db:5432". At least one of host/port/url env must be set; the peer is auto-kept in needs by the editor.
export interface WiringRow {
  service: string // peer service name (a declared topology service)
  hostEnv: string // env var to receive the peer host (empty = skip)
  portEnv: string // env var to receive the peer port (empty = skip)
  urlEnv: string // env var to receive the peer url (empty = skip)
}

export interface ServiceRow {
  name: string
  slot: string // slot name the instance pins (if left empty, name)
  // This slot's default image. Left empty, an instance MUST pin it (the previous behaviour). Filled in, a variation pins only what it changes.
  image: string
  port: string
  needs: string // comma-separated
  perRun: string // comma-separated
  replicas: string
  model: string // agent-server model — a registered Model id (its connection env is injected at dispatch); empty = none
  env: EnvRow[] // static env (non-store config) — literal or secret reference
  wiring: WiringRow[] // peer address → BYO env injection (portable; the runtime fills the per-backend address)
  volumes: string // docker -v mounts, newline-separated ("vol:/data" · "/host:/c:ro")
  readinessTimeout: string // readiness polling ceiling (ms) — if left empty, unset
  readinessInterval: string // readiness polling interval (ms)
  os: string // intrinsic OS the image needs → node placement (windows/macos); '' or 'linux' = default, no gate
}

// The OS a service can require — the portable placement axis (WHAT the image needs, never a node label). 'linux' is the
// implicit default (no capability, no gate), so the form treats '' and 'linux' the same and only emits requires for windows/macos.
export const SERVICE_OS_OPTIONS = ['linux', 'windows', 'macos'] as const
// One BYO env mapping of a dependency store — env = the key the service image actually reads (e.g. VALKEY_URL),
// template = an optional {field} recomposition of the deployed store's coordinates ('' = the canonical {url}).
// Rendered at deploy time from the store Everdict actually deployed (endpoint + pool-minted creds), so the mapping —
// unlike an env literal — works unchanged on every runtime.
export interface DepInjectRow {
  env: string
  template: string
}
// How the store is managed — the ONE comprehensible axis the author chooses, replacing the raw 5-value isolateBy enum
// (which conflated three orthogonal things: physical partition mechanism, who-isolates, and deploy model). See
// docs/architecture/dependency-store-roles.md.
//   managed  = Everdict deploys the store and isolates each case automatically (physical mechanism derived from the store type).
//   agent    = the agent isolates itself per case via its own thread/session id (thread_id) — e.g. LangGraph.
//   external = a BYO store outside Everdict — not deployed; the connection is provided on the using service's env.
export type DepManagement = 'managed' | 'agent' | 'external'

export interface DepRow {
  store: string
  role: string
  purpose: 'plumbing' | 'data' // plumbing = the agent's own state (empty at start) · data = world-state seeded per-case from the dataset
  management: DepManagement // replaces the raw isolateBy choice — isolateBy is DERIVED from this + the store kind
  service: string // service that uses this store (optional; if left empty, shared across the topology)
  inject: DepInjectRow[] // BYO store env names (empty = the conventional keys only)
  // For an external (BYO) store: the connection endpoint/URL + an optional workspace-secret name. Emitted at build time
  // into the using service's env under the store's conventional key (CONVENTIONAL_CONN_KEY) — the connection's home is
  // service.env, so re-editing shows it there (this sub-form authors it once). Ignored for a managed/agent store.
  externalEndpoint: string
  externalSecret: string // workspace-secret name (unset = the endpoint is a literal)
}

// The physical isolation an Everdict-deployed store uses, derived from its kind — the author never picks this directly.
function physicalIsolateByFor(store: string): string {
  switch (store) {
    case 'redis':
      return 'key-prefix'
    case 'minio':
      return 'object-prefix'
    default:
      return 'schema' // postgres + any relational default
  }
}

// management (+ store) → the contract's isolateBy value (the internal per-case wiring vocabulary the runtime consumes).
export function isolateByForManagement(management: DepManagement, store: string): string {
  if (management === 'external') return 'external'
  if (management === 'agent') return 'thread_id'
  return physicalIsolateByFor(store)
}

// Inverse (prefill): an existing spec's isolateBy → the management choice. The physical kinds collapse to "managed".
export function managementFromIsolateBy(isolateBy: string): DepManagement {
  if (isolateBy === 'external') return 'external'
  if (isolateBy === 'thread_id') return 'agent'
  return 'managed'
}

// The conventional connection env key per store kind (mirror of the control plane's STORE_DEFS connEnv) — shown as a
// hint for an external (BYO) store so the author knows which env to set on the using service to point at their store.
export const CONVENTIONAL_CONN_KEY: Record<string, string> = {
  postgres: 'DATABASE_URL',
  redis: 'REDIS_URL',
  minio: 'AWS_S3_ENDPOINT',
}

// External (BYO) store connections → env for the service that uses them. Each external dep with an endpoint emits its
// conventional connection key (DATABASE_URL etc.) into the using service's env — a {secretRef} when a secret name is
// set, else the literal endpoint. An unset dep.service applies to every service. Merged UNDER envRowsToSpec so an
// explicit service-env row wins; the connection's canonical home is service.env (round-trippable on prefill).
export function externalConnEnv(deps: DepRow[], serviceName: string): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = {}
  for (const d of deps) {
    if (d.management !== 'external' || !d.externalEndpoint.trim()) continue
    if (d.service.trim() && d.service.trim() !== serviceName) continue
    const key = CONVENTIONAL_CONN_KEY[d.store]
    if (!key) continue
    out[key] = d.externalSecret.trim()
      ? { secretRef: d.externalSecret.trim() }
      : d.externalEndpoint.trim()
  }
  return out
}

// Template (top-level category) form state.
export interface TemplateState {
  kind: Kind
  category: string
  id: string
  version: string // shape version
  // service (topology)
  services: ServiceRow[]
  deps: DepRow[]
  frontDoorService: string
  frontDoorSubmit: string
  frontDoorTrace: string
  // Trace source (5 kinds + endpoint + authSecret/correlate/service/project) — the shared subform's value shape.
  traceSource: TraceSourceValue
  // Per-harness span→TraceEvent attribute overrides — field name → comma-separated attribute keys.
  // Empty for a GenAI-convention harness; a non-standard harness maps its own keys. See SpanAttrMapping.
  traceMapping: Record<string, string>
  // Evidence slots loaded from the spec (finalAnswer/dom/screenshot/evidence) — the editor has no UI for
  // them, so they round-trip through the form UNTOUCHED. Rebuilding the mapping from the 9 editor fields
  // alone silently deleted every slot on save (data loss on open→save).
  traceMappingSlots: SpanMappingSlots
  targetEnabled: boolean
  targetLifecycle: string
  targetObserve: string[]
  targetExtensionRef: string
  // command (declarative CLI)
  image: string
  workDir: string
  setup: string // newline-separated
  command: string
  model: string
  envRows: EnvRow[] // command env — literal or secret reference
}

const csv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
const kvLines = (s: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const ln of lines(s)) {
    const i = ln.indexOf('=')
    if (i > 0) out[ln.slice(0, i).trim()] = ln.slice(i + 1).trim()
  }
  return out
}

// The SpanAttrMapping fields — each maps a TraceEvent field to the harness's own span-attribute keys (otel/mlflow).
export const SPAN_MAPPING_FIELDS = [
  'model',
  'inputTokens',
  'outputTokens',
  'costUsd',
  'toolName',
  'toolCallId',
  'toolArgs',
  'toolResult',
  'messageText',
] as const
type SpanMappingField = (typeof SPAN_MAPPING_FIELDS)[number]

// The evidence-slot side of the mapping — everything the comma-text editor does NOT author. Preserved
// verbatim across an open→save round trip; authored via the API/MCP (`set_harness_span_attr_mapping`).
export type SpanMappingSlots = Omit<SpanAttrMapping, SpanMappingField>
// Coverage guard: if the contract grows a new mapping field, it must be claimed by the editor list or fall
// into the slots type — this trips when a new field would otherwise be dropped by recordToMapping again.
type AssertAssignable<A extends B, B> = A
type _mappingKeysCovered = AssertAssignable<
  keyof SpanAttrMapping,
  SpanMappingField | keyof SpanMappingSlots
>
export type __spanMappingCoverageGuard = _mappingKeysCovered

// SpanAttrMapping → its evidence slots (the non-editor keys), kept in form state untouched.
const mappingSlots = (m: SpanAttrMapping | undefined): SpanMappingSlots => {
  if (!m) return {}
  return {
    ...(m.finalAnswer ? { finalAnswer: m.finalAnswer } : {}),
    ...(m.dom ? { dom: m.dom } : {}),
    ...(m.screenshot ? { screenshot: m.screenshot } : {}),
    ...(m.evidence ? { evidence: m.evidence } : {}),
  }
}

// comma-text record + preserved slots → SpanAttrMapping; undefined when nothing is mapped (GenAI-convention harness).
const recordToMapping = (
  rec: Record<string, string>,
  slots: SpanMappingSlots
): SpanAttrMapping | undefined => {
  const out: Partial<Record<SpanMappingField, string[]>> = {}
  for (const f of SPAN_MAPPING_FIELDS) {
    const keys = csv(rec[f] ?? '')
    if (keys.length) out[f] = keys
  }
  const merged: SpanAttrMapping = { ...slots, ...out }
  return Object.keys(merged).length ? merged : undefined
}
// SpanAttrMapping → comma-text record (prefill an existing spec into the editor).
const mappingToRecord = (m: SpanAttrMapping | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  if (m) {
    for (const f of SPAN_MAPPING_FIELDS) {
      const keys = m[f]
      if (Array.isArray(keys)) out[f] = keys.join(', ')
    }
  }
  return out
}

// A single env line — key + [literal value | secret name reference]. When secret=true it goes to the spec as {secretRef,scope}
// so plaintext never stays in the registry (the value is injected by the control plane from the SecretStore just before execution).
// scope: "workspace" (shared) | "user" (my personal) — only meaningful when secret=true. A harness that references a user secret is visible only to that person.
export type SecretRefScope = 'user' | 'workspace'
export interface EnvRow {
  key: string
  secret: boolean
  value: string // secret=false → literal value · secret=true → secret name
  scope?: SecretRefScope // reference tier when secret=true (unspecified=workspace)
}
export type EnvValue = string | { secretRef: string; scope?: SecretRefScope }

// wiring rows → spec wiring[] (drop rows with no peer or no env target). Each kept row emits only the env names set.
export function wiringToSpec(rows: WiringRow[]): Record<string, string>[] {
  const out: Record<string, string>[] = []
  for (const r of rows) {
    const service = r.service.trim()
    const hostEnv = r.hostEnv.trim()
    const portEnv = r.portEnv.trim()
    const urlEnv = r.urlEnv.trim()
    if (!service || (!hostEnv && !portEnv && !urlEnv)) continue
    out.push({
      service,
      ...(hostEnv ? { hostEnv } : {}),
      ...(portEnv ? { portEnv } : {}),
      ...(urlEnv ? { urlEnv } : {}),
    })
  }
  return out
}

// spec wiring[] → wiring rows (prefill inverse). Non-object entries are skipped.
export function wiringFromSpec(wiring: unknown): WiringRow[] {
  if (!Array.isArray(wiring)) return []
  return wiring.flatMap((w) => {
    if (typeof w !== 'object' || w === null) return []
    const o = w as Record<string, unknown>
    if (typeof o.service !== 'string') return []
    return [
      {
        service: o.service,
        hostEnv: typeof o.hostEnv === 'string' ? o.hostEnv : '',
        portEnv: typeof o.portEnv === 'string' ? o.portEnv : '',
        urlEnv: typeof o.urlEnv === 'string' ? o.urlEnv : '',
      },
    ]
  })
}

// env rows → spec env map (excluding empty keys). Literal=string, secret=reference object (+scope; workspace is the default so it's omitted).
export function envRowsToSpec(rows: EnvRow[]): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = {}
  for (const r of rows) {
    const k = r.key.trim()
    if (!k) continue
    out[k] = r.secret
      ? { secretRef: r.value.trim(), ...(r.scope === 'user' ? { scope: 'user' as const } : {}) }
      : r.value
  }
  return out
}

// spec env map → env rows (prefill inverse transform). {secretRef} becomes a secret row (+scope); any other string becomes a literal row.
export function envRowsFromSpec(env: unknown): EnvRow[] {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return []
  return Object.entries(env as Record<string, unknown>).map(([key, v]) => {
    if (
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      typeof (v as { secretRef?: unknown }).secretRef === 'string'
    ) {
      const ref = v as { secretRef: string; scope?: unknown }
      return {
        key,
        secret: true,
        value: ref.secretRef,
        scope: ref.scope === 'user' ? ('user' as const) : ('workspace' as const),
      }
    }
    return {
      key,
      secret: false,
      value: typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '',
    }
  })
}

// Assemble the template (top-level category) spec.
export function buildTemplate(s: TemplateState): Record<string, unknown> {
  const base = { category: s.category || 'custom', id: s.id, version: s.version }
  if (s.kind === 'process') return { kind: 'process', ...base }
  if (s.kind === 'command') {
    return {
      kind: 'command',
      ...base,
      ...(s.image.trim() ? { image: s.image } : {}),
      ...(s.workDir.trim() ? { workDir: s.workDir } : {}),
      setup: lines(s.setup),
      command: s.command,
      env: envRowsToSpec(s.envRows),
      ...(s.model.trim() ? { model: s.model } : {}),
    }
  }
  const spec: Record<string, unknown> = {
    kind: 'service',
    ...base,
    services: s.services.map((sv) => {
      // Merge BYO external-store connections in FIRST so an explicit service-env row still wins.
      const env = { ...externalConnEnv(s.deps, sv.name), ...envRowsToSpec(sv.env) }
      const volumes = lines(sv.volumes)
      const wiring = wiringToSpec(sv.wiring)
      const hasReadiness = sv.readinessTimeout.trim() !== '' || sv.readinessInterval.trim() !== ''
      return {
        name: sv.name,
        ...(sv.slot.trim() ? { slot: sv.slot } : {}), // if left empty, the control plane uses name as the slot
        // A host-exec service has no container, so no image is carried (the contract refuses one).
        ...(sv.image.trim() ? { image: sv.image.trim() } : {}),
        ...(sv.port.trim() ? { port: Number(sv.port) } : {}),
        needs: csv(sv.needs),
        perRun: csv(sv.perRun),
        replicas: sv.replicas.trim() ? Number(sv.replicas) : 1,
        ...(sv.model.trim() ? { model: sv.model.trim() } : {}), // registered Model id → connection env injected at dispatch
        ...(Object.keys(env).length ? { env } : {}),
        ...(wiring.length ? { wiring } : {}),
        ...(volumes.length ? { volumes } : {}),
        // linux is the default (no placement gate) — only a non-linux OS carries an intrinsic requirement to a runtime.
        ...(sv.os.trim() && sv.os.trim() !== 'linux' ? { requires: { os: sv.os.trim() } } : {}),
        ...(hasReadiness
          ? {
              readiness: {
                timeoutMs: Number(sv.readinessTimeout.trim() || 60000),
                intervalMs: Number(sv.readinessInterval.trim() || 1000),
              },
            }
          : {}),
      }
    }),
    dependencies: s.deps.map((d) => {
      const isolateBy = isolateByForManagement(d.management, d.store)
      // external = Everdict deploys nothing, so there are no coordinates to render — never emit inject there
      // (the control plane rejects it; the form simply drops rows left over from a mode switch).
      const inject = (d.management === 'external' ? [] : d.inject)
        .filter((m) => m.env.trim())
        .map((m) => ({
          env: m.env.trim(),
          ...(m.template.trim() ? { template: m.template.trim() } : {}),
        }))
      return {
        store: d.store,
        role: d.role,
        // Emit only the non-default (data); plumbing is the control-plane default, so omitting keeps the wire minimal.
        ...(d.purpose === 'data' ? { purpose: 'data' as const } : {}),
        isolateBy,
        ...(d.service.trim() ? { service: d.service.trim() } : {}),
        ...(inject.length ? { inject } : {}),
      }
    }),
    frontDoor: {
      service: s.frontDoorService,
      submit: s.frontDoorSubmit,
      ...(s.frontDoorTrace.trim() ? { trace: s.frontDoorTrace } : {}),
    },
    traceSource: {
      ...traceSourceToSpec(s.traceSource),
      ...(() => {
        const mapping = recordToMapping(s.traceMapping, s.traceMappingSlots)
        return mapping ? { mapping } : {}
      })(),
    },
  }
  if (s.targetEnabled) {
    spec.target = {
      kind: 'browser',
      engine: 'chromium',
      lifecycle: s.targetLifecycle,
      observe: s.targetObserve,
      ...(s.targetExtensionRef.trim() ? { extension: { ref: s.targetExtensionRef } } : {}),
    }
  }
  return spec
}

// template spec → template form state (prefill for editing a new shape version). Inverse of buildTemplate.
// Form fields are string/array based, so unset is left as an empty string (UI state, not a domain value).
export function templateStateFromSpec(t: HarnessTemplateSpec): TemplateState {
  const env = t.env ?? {}
  return {
    kind: t.kind,
    category: t.category,
    id: t.id,
    version: t.version,
    services: (t.services ?? []).map((s) => ({
      name: s.name,
      slot: s.slot ?? '',
      image: s.image ?? '',
      port: s.port !== undefined ? String(s.port) : '',
      needs: (s.needs ?? []).join(', '),
      perRun: (s.perRun ?? []).join(', '),
      replicas: s.replicas !== undefined ? String(s.replicas) : '1',
      model: typeof s.model === 'string' ? s.model : '', // only a bare-id binding round-trips into the form (object bindings via API)
      env: envRowsFromSpec(s.env),
      wiring: wiringFromSpec(s.wiring),
      volumes: (s.volumes ?? []).join('\n'),
      readinessTimeout: s.readiness?.timeoutMs !== undefined ? String(s.readiness.timeoutMs) : '',
      readinessInterval:
        s.readiness?.intervalMs !== undefined ? String(s.readiness.intervalMs) : '',
      os: s.requires?.os ?? '', // unset in the spec → default (linux) in the form
    })),
    deps: (t.dependencies ?? []).map((d) => ({
      store: d.store,
      role: d.role,
      purpose: d.purpose === 'data' ? ('data' as const) : ('plumbing' as const),
      management: managementFromIsolateBy(d.isolateBy),
      service: d.service ?? '',
      inject: (d.inject ?? []).map((m) => ({ env: m.env, template: m.template ?? '' })),
      // The external connection lives in the service's env after the first save (round-trips there), so the sub-form
      // starts empty on re-edit — filling it again re-authors the same key.
      externalEndpoint: '',
      externalSecret: '',
    })),
    frontDoorService: t.frontDoor?.service ?? '',
    frontDoorSubmit: t.frontDoor?.submit ?? '',
    frontDoorTrace: t.frontDoor?.trace ?? '',
    traceSource: {
      kind: t.traceSource?.kind ?? 'mlflow',
      endpoint: t.traceSource?.endpoint ?? '',
      authSecret: t.traceSource?.authSecret ?? '',
      correlate: t.traceSource?.correlate ?? '',
      service: t.traceSource?.service ?? '',
      project: t.traceSource?.project ?? '',
      artifactBaseUrl: t.traceSource?.artifactBaseUrl ?? '',
    },
    traceMapping: mappingToRecord(t.traceSource?.mapping),
    traceMappingSlots: mappingSlots(t.traceSource?.mapping),
    targetEnabled: t.target !== undefined,
    targetLifecycle: t.target?.lifecycle ?? 'per-case-instance',
    targetObserve: t.target?.observe ?? ['dom', 'screenshot', 'url'],
    targetExtensionRef: t.target?.extension?.ref ?? '',
    image: t.image ?? '',
    workDir: t.workDir ?? '',
    setup: (t.setup ?? []).join('\n'),
    command: t.command ?? '',
    model: t.model ?? '',
    envRows: envRowsFromSpec(env),
  }
}

// Slot names (referenced when the instance form renders pin inputs). service=service slots, command=image/model.
export function templateSlots(s: TemplateState): string[] {
  if (s.kind === 'service') return s.services.map((sv) => sv.slot.trim() || sv.name).filter(Boolean)
  if (s.kind === 'command') return ['image', 'model']
  return []
}

export interface PinRow {
  slot: string
  value: string
  // Store provenance when the value was inserted from an environment capability ("From store" picker) — cleared the
  // moment the value is hand-edited so the annotation never lies. Emitted as HarnessInstanceSpec.pinSources.
  source?: { source: string; id: string; version: string }
}

// Per-service override row (overrides.services[name]) — the shape (template) stays; only behavior knobs are a delta.
export interface ServiceOverrideRow {
  service: string // target service name (must exist in the template)
  env: EnvRow[] // service env overlay — literal or secret reference
  model: string // agent-server model binding (registered Model id); empty = the template's
  replicas: string // number or empty
  cpu: string // resources.cpu (millicores, 1000=1 core)
  memoryMb: string // resources.memoryMb
  volumes: string // newline-separated ("vol:/data" · "/host:/c:ro")
  readinessTimeout: string // ms
  readinessInterval: string // ms
}

export interface InstanceState {
  templateId: string
  templateVersion: string
  // This harness's NAME. Several harnesses with different names can sit on one template (shape) — pushing a variation that differs only in
  // env or model in as "a new version of the same id" turns the version list into a mixture of *newer* and *different*. Empty falls back to templateId.
  id: string
  version: string // instance tag (e.g. pr-123-sha-abc)
  description: string // this version's changelog (free text) — entered at deploy time, shown in detail
  pins: PinRow[]
  // overrides — shape-invariant behavior delta (structured edit). The control plane does the final schema validation.
  serviceOverrides: ServiceOverrideRow[] // service template: per-service env/replicas/resources/volumes/readiness
  bodyTemplate: string // service: front-door submit body value (JSON object; free form)
  completionTimeout: string // service: front-door completion timeoutMs
  completionInterval: string // service: front-door completion (poll) intervalMs
  targetExtensionRef: string // service: browser target extension ref pin
  cmdEnvRows: EnvRow[] // command: env overlay — literal or secret reference
  cmdParams: string // command: {{var}} values (KEY=VALUE, newline-separated)
  cmdCpu: string // command: job resources.cpu
  cmdMemoryMb: string // command: job resources.memoryMb
}

const EMPTY_SERVICE_OVERRIDE: ServiceOverrideRow = {
  service: '',
  env: [],
  model: '',
  replicas: '',
  cpu: '',
  memoryMb: '',
  volumes: '',
  readinessTimeout: '',
  readinessInterval: '',
}

// --- The baseline for editing the EFFECTIVE configuration ---
// The instance form is not a delta editor but an **effective-configuration editor**: it shows the values the template set (inherited) and
// exports only what the user changed as overrides. With the effective value absent from the screen, a person goes off to edit the TEMPLATE,
// where the value is visible, and changing one env line mints a new shape version — this baseline cuts that path off.
// known=false is the free-input path where the template is not known yet (unchanged behaviour: pure delta editing).
// A baseline service row has the same shape as an edit row — that is what makes "lay down the inherited values and edit on top" one data
// type, and what lets the two be placed side by side to take a delta.
export type ServiceOverrideBaseline = ServiceOverrideRow

export interface OverrideBaseline {
  known: boolean
  services: ServiceOverrideBaseline[]
  bodyTemplate: string
  completionTimeout: string
  completionInterval: string
  targetExtensionRef: string
  cmdEnvRows: EnvRow[]
  cmdParams: string
  cmdCpu: string
  cmdMemoryMb: string
}

export const EMPTY_BASELINE: OverrideBaseline = {
  known: false,
  services: [],
  bodyTemplate: '',
  completionTimeout: '',
  completionInterval: '',
  targetExtensionRef: '',
  cmdEnvRows: [],
  cmdParams: '',
  cmdCpu: '',
  cmdMemoryMb: '',
}

// Template spec → baseline. It holds only the fields an instance may override (the shape itself is not here).
export function baselineFromTemplate(t: HarnessTemplateSpec): OverrideBaseline {
  const completion = t.frontDoor?.completion
  return {
    known: true,
    services: (t.services ?? []).map((s) => ({
      service: s.name,
      env: envRowsFromSpec(s.env),
      model: typeof s.model === 'string' ? s.model : '', // bare-id bindings round-trip; object ModelRefs stay API-only
      replicas: s.replicas !== undefined ? String(s.replicas) : '',
      cpu: s.resources?.cpu !== undefined ? String(s.resources.cpu) : '',
      memoryMb: s.resources?.memoryMb !== undefined ? String(s.resources.memoryMb) : '',
      volumes: (s.volumes ?? []).join('\n'),
      readinessTimeout: s.readiness?.timeoutMs !== undefined ? String(s.readiness.timeoutMs) : '',
      readinessInterval:
        s.readiness?.intervalMs !== undefined ? String(s.readiness.intervalMs) : '',
    })),
    bodyTemplate: t.frontDoor?.request?.bodyTemplate
      ? JSON.stringify(t.frontDoor.request.bodyTemplate, null, 2)
      : '',
    completionTimeout:
      typeof completion?.timeoutMs === 'number' ? String(completion.timeoutMs) : '',
    completionInterval:
      typeof completion?.intervalMs === 'number' ? String(completion.intervalMs) : '',
    targetExtensionRef: t.target?.extension?.ref ?? '',
    cmdEnvRows: envRowsFromSpec(t.env),
    cmdParams: Object.entries(t.params ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    cmdCpu: t.resources?.cpu !== undefined ? String(t.resources.cpu) : '',
    cmdMemoryMb: t.resources?.memoryMb !== undefined ? String(t.resources.memoryMb) : '',
  }
}

// A baseline service row (an empty baseline when there is none) — so that on a path where the template is unknown, the diff IS "everything is a delta".
export function serviceBaselineFor(
  baseline: OverrideBaseline,
  service: string
): ServiceOverrideBaseline {
  return (
    baseline.services.find((b) => b.service === service) ?? { ...EMPTY_SERVICE_OVERRIDE, service }
  )
}

// A scalar delta — not exported when equal to the baseline (the merge result is the same and only the spec swells). Empty means "inherit".
const scalarDelta = (effective: string, base: string): string =>
  effective.trim() === base.trim() ? '' : effective.trim()

// env value equality. `envRowsToSpec` exports keys in a fixed order, so comparing serializations is stable.
const sameEnvValue = (a: EnvValue | undefined, b: EnvValue): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b)

// Effective env rows → the delta (only the keys whose value differs from the baseline).
export function envDelta(effective: EnvRow[], base: EnvRow[]): Record<string, EnvValue> {
  const baseSpec = envRowsToSpec(base)
  const out: Record<string, EnvValue> = {}
  for (const [k, v] of Object.entries(envRowsToSpec(effective))) {
    if (sameEnvValue(baseSpec[k], v)) continue
    out[k] = v
  }
  return out
}

// An inherited key deleted on screen → unsetEnv. In an effective-configuration editor "I deleted the row" means "this variation does not have
// it", and because overrides MERGE, that meaning needs a field of its own (the contract's unsetEnv).
export function envUnset(effective: EnvRow[], base: EnvRow[]): string[] {
  if (base.length === 0) return []
  const kept = new Set(effective.map((r) => r.key.trim()).filter(Boolean))
  return base.map((b) => b.key).filter((k) => k !== '' && !kept.has(k))
}

// A per-key delta over KEY=VALUE text (command params).
function kvDelta(effective: string, base: string): Record<string, string> {
  const baseMap = kvLines(base)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(kvLines(effective))) {
    if (baseMap[k] === v) continue
    out[k] = v
  }
  return out
}

// A per-key delta over a JSON object (the front-door submit body). The control plane does a shallow merge, so per-key is enough.
function objectDelta(
  effective: Record<string, unknown>,
  base: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(effective)) {
    if (k in base && JSON.stringify(base[k]) === JSON.stringify(v)) continue
    out[k] = v
  }
  return out
}

// env baseline ⊕ delta − unset → the effective rows (baseline order first, then keys only the delta has). These are what the editor shows,
// and a key not on screen is not in the run either (which is why unset must drop out here — otherwise a deleted key comes back).
export function mergeEnvRows(base: EnvRow[], delta: EnvRow[], unset: string[] = []): EnvRow[] {
  const byKey = new Map(delta.map((r) => [r.key, r]))
  const dropped = new Set(unset)
  const merged = base.filter((b) => !dropped.has(b.key)).map((b) => byKey.get(b.key) ?? b)
  const baseKeys = new Set(base.map((b) => b.key))
  return [...merged, ...delta.filter((r) => !baseKeys.has(r.key) && !dropped.has(r.key))]
}

// Safe extraction of the string array (unsetEnv) out of overrides — it is loose JSON, so a non-string entry is discarded.
const asStrArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

// Merging KEY=VALUE text (preserving baseline order).
function mergeKvLines(base: string, delta: string): string {
  const merged = { ...kvLines(base), ...kvLines(delta) }
  return Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

// Parse JSON object text (for the front-door body) — empty=unset (ok). Not an object / JSON error → error (the form blocks registration).
export function parseJsonObject(
  text: string
): { ok: true; value?: Record<string, unknown> } | { ok: false; error: string } {
  const t = text.trim()
  if (!t) return { ok: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch (e) {
    // Return an error code — the consumer (register-harness-wizard) translates it with t() for display. e.message is the engine's original (English) text as-is.
    return { ok: false, error: e instanceof Error ? e.message : 'invalidJson' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'notObject' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

// The form's **effective configuration** → overrides (only what differs from the baseline). With no baseline known (EMPTY_BASELINE) the whole
// input becomes the delta, which is the previous behaviour. A bodyTemplate parse error is blocked by the form, so it is ignored here.
export function buildOverrides(
  s: InstanceState,
  baseline: OverrideBaseline = EMPTY_BASELINE
): Record<string, unknown> | undefined {
  const overrides: Record<string, unknown> = {}
  // per-service overrides
  const services: Record<string, unknown> = {}
  for (const r of s.serviceOverrides) {
    const name = r.service.trim()
    if (!name) continue
    const b = serviceBaselineFor(baseline, name)
    const o: Record<string, unknown> = {}
    const env = envDelta(r.env, b.env)
    if (Object.keys(env).length) o.env = env
    const unsetEnv = envUnset(r.env, b.env)
    if (unsetEnv.length) o.unsetEnv = unsetEnv
    const model = scalarDelta(r.model, b.model)
    if (model) o.model = model
    const replicas = scalarDelta(r.replicas, b.replicas)
    if (replicas) o.replicas = Number(replicas)
    // resources is a scalar REPLACE at resolve, so changing one half must re-state the inherited other half —
    // emitting {memoryMb} alone would silently drop the template's cpu.
    const resources: Record<string, number> = {}
    if (scalarDelta(r.cpu, b.cpu) || scalarDelta(r.memoryMb, b.memoryMb)) {
      const cpu = r.cpu.trim() || b.cpu.trim()
      const memoryMb = r.memoryMb.trim() || b.memoryMb.trim()
      if (cpu) resources.cpu = Number(cpu)
      if (memoryMb) resources.memoryMb = Number(memoryMb)
    }
    if (Object.keys(resources).length) o.resources = resources
    // volumes/readiness are scalar replacements, so a difference in even one entry re-emits the whole thing.
    if (r.volumes.trim() !== b.volumes.trim()) {
      const vols = lines(r.volumes)
      if (vols.length) o.volumes = vols
    }
    const readinessChanged =
      r.readinessTimeout.trim() !== b.readinessTimeout.trim() ||
      r.readinessInterval.trim() !== b.readinessInterval.trim()
    if (readinessChanged && (r.readinessTimeout.trim() || r.readinessInterval.trim())) {
      o.readiness = {
        timeoutMs: Number(r.readinessTimeout.trim() || b.readinessTimeout.trim() || 60000),
        intervalMs: Number(r.readinessInterval.trim() || b.readinessInterval.trim() || 1000),
      }
    }
    if (Object.keys(o).length) services[name] = o
  }
  if (Object.keys(services).length) overrides.services = services
  // front-door: body value + completion timing
  const frontDoor: Record<string, unknown> = {}
  const body = parseJsonObject(s.bodyTemplate)
  const baseBody = parseJsonObject(baseline.bodyTemplate)
  if (body.ok && body.value) {
    const delta = objectDelta(body.value, (baseBody.ok && baseBody.value) || {})
    if (Object.keys(delta).length) frontDoor.request = { bodyTemplate: delta }
  }
  const completion: Record<string, number> = {}
  const timeout = scalarDelta(s.completionTimeout, baseline.completionTimeout)
  const interval = scalarDelta(s.completionInterval, baseline.completionInterval)
  if (timeout) completion.timeoutMs = Number(timeout)
  if (interval) completion.intervalMs = Number(interval)
  if (Object.keys(completion).length) frontDoor.completion = completion
  if (Object.keys(frontDoor).length) overrides.frontDoor = frontDoor
  // target extension ref
  const ext = scalarDelta(s.targetExtensionRef, baseline.targetExtensionRef)
  if (ext) overrides.target = { extension: { ref: ext } }
  // command env/params/resources
  const cmdEnv = envDelta(s.cmdEnvRows, baseline.cmdEnvRows)
  if (Object.keys(cmdEnv).length) overrides.env = cmdEnv
  const cmdUnsetEnv = envUnset(s.cmdEnvRows, baseline.cmdEnvRows)
  if (cmdUnsetEnv.length) overrides.unsetEnv = cmdUnsetEnv
  const cmdParams = kvDelta(s.cmdParams, baseline.cmdParams)
  if (Object.keys(cmdParams).length) overrides.params = cmdParams
  const cmdResources: Record<string, number> = {}
  const cmdCpu = scalarDelta(s.cmdCpu, baseline.cmdCpu)
  const cmdMemoryMb = scalarDelta(s.cmdMemoryMb, baseline.cmdMemoryMb)
  // resources is a scalar REPLACE, so a changed half must carry the inherited other half or it silently unsets it.
  if (cmdCpu || cmdMemoryMb) {
    const cpu = s.cmdCpu.trim() || baseline.cmdCpu.trim()
    const memoryMb = s.cmdMemoryMb.trim() || baseline.cmdMemoryMb.trim()
    if (cpu) cmdResources.cpu = Number(cpu)
    if (memoryMb) cmdResources.memoryMb = Number(memoryMb)
  }
  if (Object.keys(cmdResources).length) overrides.resources = cmdResources
  return Object.keys(overrides).length ? overrides : undefined
}

// Assemble the instance spec (template reference + pins + overrides). overrides is included only when non-empty.
// `id` is the harness's NAME — it falls back to templateId only when empty (the convention for the first harness on a shape).
export function buildInstance(
  s: InstanceState,
  baseline: OverrideBaseline = EMPTY_BASELINE
): Record<string, unknown> {
  const pins: Record<string, string> = {}
  const pinSources: Record<string, { source: string; id: string; version: string }> = {}
  for (const p of s.pins) {
    if (!p.slot.trim() || !p.value.trim()) continue
    pins[p.slot.trim()] = p.value.trim()
    if (p.source) pinSources[p.slot.trim()] = p.source
  }
  const overrides = buildOverrides(s, baseline)
  return {
    template: { id: s.templateId, version: s.templateVersion },
    id: s.id.trim() || s.templateId,
    version: s.version,
    ...(s.description.trim() ? { description: s.description.trim() } : {}),
    pins,
    ...(Object.keys(pinSources).length > 0 ? { pinSources } : {}),
    ...(overrides ? { overrides } : {}),
  }
}

export const INITIAL_TEMPLATE: TemplateState = {
  kind: 'command',
  category: 'cli-agent',
  id: '',
  version: '1.0.0',
  services: [
    {
      name: 'agent-server',
      slot: 'agent-server',
      image: '',
      port: '8080',
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
  deps: [],
  frontDoorService: 'agent-server',
  frontDoorSubmit: 'POST /runs',
  frontDoorTrace: '',
  traceSource: {
    kind: 'mlflow',
    endpoint: '',
    authSecret: '',
    correlate: '',
    service: '',
    project: '',
    artifactBaseUrl: '',
  },
  traceMapping: {},
  traceMappingSlots: {},
  targetEnabled: false,
  targetLifecycle: 'per-case-instance',
  targetObserve: ['dom', 'screenshot', 'url'],
  targetExtensionRef: '',
  image: '',
  workDir: '',
  setup: '',
  command: '',
  model: '',
  envRows: [],
}

export const INITIAL_INSTANCE: InstanceState = {
  templateId: '',
  templateVersion: '1.0.0',
  id: '',
  version: '',
  description: '',
  pins: [{ slot: 'image', value: '' }],
  serviceOverrides: [],
  bodyTemplate: '',
  completionTimeout: '',
  completionInterval: '',
  targetExtensionRef: '',
  cmdEnvRows: [],
  cmdParams: '',
  cmdCpu: '',
  cmdMemoryMb: '',
}

// raw instance spec → instance form state (prefill for editing a new version). version is left empty to force a new tag
// (re-registering the same tag is an immutability violation, 409). If slots is given, expand all of them into rows (nothing dropped) and merge existing values.
// overrides (loose JSON) safe-extraction helpers — the form is string based, so numbers/maps are reduced to strings/newlines.
const asObj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
const asStr = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
const numStr = (v: unknown): string => (typeof v === 'number' ? String(v) : '')
const kvToLines = (v: unknown): string => {
  const o = asObj(v)
  return o
    ? Object.entries(o)
        .map(([k, val]) => `${k}=${asStr(val)}`)
        .join('\n')
    : ''
}

// existing overrides → structured form state (starting point for editing a new version). Inverse of buildOverrides.
// unsetEnv is not a row but "a key that must be ABSENT", so it is carried separately and applied at merge time.
function serviceOverridesFromSpec(
  ov: Record<string, unknown>
): { row: ServiceOverrideRow; unsetEnv: string[] }[] {
  const services = asObj(ov.services)
  if (!services) return []
  return Object.entries(services).map(([service, raw]) => {
    const o = asObj(raw) ?? {}
    const res = asObj(o.resources) ?? {}
    const rd = asObj(o.readiness) ?? {}
    return {
      unsetEnv: asStrArray(o.unsetEnv),
      row: {
        service,
        env: envRowsFromSpec(o.env),
        model: typeof o.model === 'string' ? o.model : '',
        replicas: numStr(o.replicas),
        cpu: numStr(res.cpu),
        memoryMb: numStr(res.memoryMb),
        volumes: Array.isArray(o.volumes) ? o.volumes.map(asStr).filter(Boolean).join('\n') : '',
        readinessTimeout: numStr(rd.timeoutMs),
        readinessInterval: numStr(rd.intervalMs),
      },
    }
  })
}

// Prefill a template service row (and append missing dependencies) from a store ENVIRONMENT's composition preset —
// the authoring-time consumption of the dowry (docs/architecture/environment-image-store.md). Only fields the preset
// carries are overwritten; everything else keeps the author's values. Dependencies are appended when no row with the
// same store+role exists (management reverse-derived from the preset's isolateBy); the row's service scope defaults to
// the prefilled service. Structurally typed so the caller passes the entity's preset without a cross-entity import.
export function applyEnvironmentPreset(
  s: TemplateState,
  serviceIndex: number,
  preset: {
    service?: {
      port?: number
      needs?: string[]
      perRun?: string[]
      env?: Record<string, string | { secretRef: string; scope?: 'user' | 'workspace' }>
      wiring?: { service: string; hostEnv?: string; portEnv?: string; urlEnv?: string }[]
      readiness?: { timeoutMs?: number; intervalMs?: number }
      requires?: { os?: string }
    }
    dependencies?: {
      store: string
      role: string
      purpose?: 'plumbing' | 'data'
      isolateBy: string
      service?: string
      inject?: { env: string; template?: string }[]
    }[]
  }
): TemplateState {
  const svc = preset.service
  const services = s.services.map((row, j) => {
    if (j !== serviceIndex || !svc) return row
    const envRows: EnvRow[] = Object.entries(svc.env ?? {}).map(([key, v]) =>
      typeof v === 'string'
        ? { key, secret: false, value: v }
        : { key, secret: true, value: v.secretRef, ...(v.scope ? { scope: v.scope } : {}) }
    )
    return {
      ...row,
      ...(svc.port !== undefined ? { port: String(svc.port) } : {}),
      ...(svc.needs && svc.needs.length > 0 ? { needs: svc.needs.join(', ') } : {}),
      ...(svc.perRun && svc.perRun.length > 0 ? { perRun: svc.perRun.join(', ') } : {}),
      ...(envRows.length > 0 ? { env: envRows } : {}),
      ...(svc.wiring && svc.wiring.length > 0
        ? {
            wiring: svc.wiring.map((w) => ({
              service: w.service,
              hostEnv: w.hostEnv ?? '',
              portEnv: w.portEnv ?? '',
              urlEnv: w.urlEnv ?? '',
            })),
          }
        : {}),
      ...(svc.readiness?.timeoutMs !== undefined
        ? { readinessTimeout: String(svc.readiness.timeoutMs) }
        : {}),
      ...(svc.readiness?.intervalMs !== undefined
        ? { readinessInterval: String(svc.readiness.intervalMs) }
        : {}),
      ...(svc.requires?.os ? { os: svc.requires.os } : {}),
    }
  })
  const serviceName = s.services[serviceIndex]?.name.trim() ?? ''
  const existing = new Set(s.deps.map((d) => `${d.store} ${d.role}`))
  const appended: DepRow[] = (preset.dependencies ?? [])
    .filter((d) => !existing.has(`${d.store} ${d.role}`))
    .map((d) => ({
      store: d.store,
      role: d.role,
      purpose: d.purpose ?? 'plumbing',
      management:
        d.isolateBy === 'external' ? 'external' : d.isolateBy === 'thread_id' ? 'agent' : 'managed',
      service: d.service ?? serviceName,
      inject: (d.inject ?? []).map((x) => ({ env: x.env, template: x.template ?? '' })),
      externalEndpoint: '',
      externalSecret: '',
    }))
  return { ...s, services, deps: appended.length > 0 ? [...s.deps, ...appended] : s.deps }
}

export function instanceStateFromSpec(
  inst: {
    template: { id: string; version: string }
    id: string
    version: string
    pins: Record<string, string>
    pinSources?: Record<string, { source: string; id: string; version: string }>
    overrides?: Record<string, unknown>
  },
  slots?: string[],
  // The template baseline. Given one, the form is filled with the **effective configuration** (inherited ⊕ delta) — without it the env box
  // looks empty, which reads as "environment variables live only on the template", and a person goes off to edit the shape.
  baseline: OverrideBaseline = EMPTY_BASELINE
): InstanceState {
  const rowOf = (slot: string, value: string): PinRow => {
    const source = inst.pinSources?.[slot]
    return { slot, value, ...(source ? { source } : {}) }
  }
  const rows: PinRow[] =
    slots && slots.length > 0
      ? slots.map((slot) => rowOf(slot, inst.pins[slot] ?? ''))
      : Object.entries(inst.pins).map(([slot, value]) => rowOf(slot, value))
  const ov = inst.overrides ?? {}
  const fd = asObj(ov.frontDoor)
  const body = asObj(asObj(fd?.request)?.bodyTemplate)
  const completion = asObj(fd?.completion)
  const ext = asObj(asObj(ov.target)?.extension)
  const baseBody = parseJsonObject(baseline.bodyTemplate)
  const effectiveBody = { ...((baseBody.ok && baseBody.value) || {}), ...(body ?? {}) }
  return {
    templateId: inst.template.id,
    templateVersion: inst.template.version,
    id: inst.id, // the name carries over — a new version must not register as a DIFFERENT harness
    version: '',
    description: '', // a new version gets a new changelog — it does not inherit the previous version's description (same spirit as version tags)
    pins: rows.length > 0 ? rows : [{ slot: '', value: '' }],
    serviceOverrides: effectiveServiceRows(baseline, serviceOverridesFromSpec(ov)),
    bodyTemplate: Object.keys(effectiveBody).length ? JSON.stringify(effectiveBody, null, 2) : '',
    completionTimeout: numStr(completion?.timeoutMs) || baseline.completionTimeout,
    completionInterval: numStr(completion?.intervalMs) || baseline.completionInterval,
    targetExtensionRef: asStr(ext?.ref) || baseline.targetExtensionRef,
    cmdEnvRows: mergeEnvRows(baseline.cmdEnvRows, envRowsFromSpec(ov.env), asStrArray(ov.unsetEnv)),
    cmdParams: mergeKvLines(baseline.cmdParams, kvToLines(ov.params)),
    cmdCpu: numStr(asObj(ov.resources)?.cpu) || baseline.cmdCpu,
    cmdMemoryMb: numStr(asObj(ov.resources)?.memoryMb) || baseline.cmdMemoryMb,
  }
}

// One row per service in the template — the inherited values laid down with this instance's delta on top. An existing delta pointing at a
// service the template does not have is appended rather than dropped: dropping it silently makes a typo the control plane refuses disappear from the screen.
export function effectiveServiceRows(
  baseline: OverrideBaseline,
  deltas: { row: ServiceOverrideRow; unsetEnv: string[] }[]
): ServiceOverrideRow[] {
  if (!baseline.known) return deltas.map((d) => d.row)
  const byName = new Map(deltas.map((d) => [d.row.service.trim(), d]))
  const rows = baseline.services.map((b) => {
    const d = byName.get(b.service)
    if (!d) return { ...b }
    return {
      service: b.service,
      env: mergeEnvRows(b.env, d.row.env, d.unsetEnv),
      model: d.row.model || b.model,
      replicas: d.row.replicas || b.replicas,
      cpu: d.row.cpu || b.cpu,
      memoryMb: d.row.memoryMb || b.memoryMb,
      volumes: d.row.volumes || b.volumes,
      readinessTimeout: d.row.readinessTimeout || b.readinessTimeout,
      readinessInterval: d.row.readinessInterval || b.readinessInterval,
    }
  })
  const known = new Set(baseline.services.map((b) => b.service))
  return [...rows, ...deltas.filter((d) => !known.has(d.row.service.trim())).map((d) => d.row)]
}

// The initial state of a new instance built from the template alone — every slot row plus the effective-configuration prefill.
export function instanceStateFromTemplate(
  t: HarnessTemplateSpec,
  slots: string[],
  baseline: OverrideBaseline
): InstanceState {
  return instanceStateFromSpec(
    { template: { id: t.id, version: t.version }, id: '', version: '', pins: {} },
    slots,
    baseline
  )
}

export { EMPTY_SERVICE_OVERRIDE }
