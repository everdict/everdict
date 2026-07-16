// Assemble wizard form state → HarnessTemplateSpec / HarnessInstanceSpec (pure). The control plane does the final schema/conflict validation.
// Template (top-level category) = shape/slots (version not pinned); Instance = template reference + pins (slot→image/value).
import type { HarnessTemplateSpec } from '@/entities/harness'
import { type TraceSourceValue, traceSourceToSpec } from '@/entities/trace-source'

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
}
export interface DepRow {
  store: string
  role: string
  isolateBy: string // …/schema | external (BYO external store — not deployed by Everdict; connection is env at deploy time)
  service: string // service that uses this store (optional; if left empty, shared across the topology)
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

// comma-text record → SpanAttrMapping (only non-empty fields); undefined when nothing is mapped (a GenAI-convention harness).
const recordToMapping = (rec: Record<string, string>): Record<string, string[]> | undefined => {
  const out: Record<string, string[]> = {}
  for (const f of SPAN_MAPPING_FIELDS) {
    const keys = csv(rec[f] ?? '')
    if (keys.length) out[f] = keys
  }
  return Object.keys(out).length ? out : undefined
}
// SpanAttrMapping → comma-text record (prefill an existing spec into the editor).
const mappingToRecord = (m: Record<string, string[]> | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  if (m) for (const f of SPAN_MAPPING_FIELDS) if (Array.isArray(m[f])) out[f] = m[f].join(', ')
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
      const env = envRowsToSpec(sv.env)
      const volumes = lines(sv.volumes)
      const wiring = wiringToSpec(sv.wiring)
      const hasReadiness = sv.readinessTimeout.trim() !== '' || sv.readinessInterval.trim() !== ''
      return {
        name: sv.name,
        ...(sv.slot.trim() ? { slot: sv.slot } : {}), // if left empty, the control plane uses name as the slot
        ...(sv.port.trim() ? { port: Number(sv.port) } : {}),
        needs: csv(sv.needs),
        perRun: csv(sv.perRun),
        replicas: sv.replicas.trim() ? Number(sv.replicas) : 1,
        ...(sv.model.trim() ? { model: sv.model.trim() } : {}), // registered Model id → connection env injected at dispatch
        ...(Object.keys(env).length ? { env } : {}),
        ...(wiring.length ? { wiring } : {}),
        ...(volumes.length ? { volumes } : {}),
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
    dependencies: s.deps.map((d) => ({
      store: d.store,
      role: d.role,
      isolateBy: d.isolateBy,
      ...(d.service.trim() ? { service: d.service.trim() } : {}),
    })),
    frontDoor: {
      service: s.frontDoorService,
      submit: s.frontDoorSubmit,
      ...(s.frontDoorTrace.trim() ? { trace: s.frontDoorTrace } : {}),
    },
    traceSource: {
      ...traceSourceToSpec(s.traceSource),
      ...(recordToMapping(s.traceMapping) ? { mapping: recordToMapping(s.traceMapping) } : {}),
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
    })),
    deps: (t.dependencies ?? []).map((d) => ({
      store: d.store,
      role: d.role,
      isolateBy: d.isolateBy,
      service: d.service ?? '',
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
    },
    traceMapping: mappingToRecord(t.traceSource?.mapping),
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
}

// Per-service override row (overrides.services[name]) — the shape (template) stays; only behavior knobs are a delta.
export interface ServiceOverrideRow {
  service: string // target service name (must exist in the template)
  env: EnvRow[] // service env overlay — literal or secret reference
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
}

const EMPTY_SERVICE_OVERRIDE: ServiceOverrideRow = {
  service: '',
  env: [],
  replicas: '',
  cpu: '',
  memoryMb: '',
  volumes: '',
  readinessTimeout: '',
  readinessInterval: '',
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

// Structured override form state → overrides object (empty knobs omitted). bodyTemplate parse errors are blocked by the form (ignored here).
export function buildOverrides(s: InstanceState): Record<string, unknown> | undefined {
  const overrides: Record<string, unknown> = {}
  // per-service overrides
  const services: Record<string, unknown> = {}
  for (const r of s.serviceOverrides) {
    const name = r.service.trim()
    if (!name) continue
    const o: Record<string, unknown> = {}
    const env = envRowsToSpec(r.env)
    if (Object.keys(env).length) o.env = env
    if (r.replicas.trim()) o.replicas = Number(r.replicas)
    const resources: Record<string, number> = {}
    if (r.cpu.trim()) resources.cpu = Number(r.cpu)
    if (r.memoryMb.trim()) resources.memoryMb = Number(r.memoryMb)
    if (Object.keys(resources).length) o.resources = resources
    const vols = lines(r.volumes)
    if (vols.length) o.volumes = vols
    if (r.readinessTimeout.trim() || r.readinessInterval.trim()) {
      o.readiness = {
        timeoutMs: Number(r.readinessTimeout.trim() || 60000),
        intervalMs: Number(r.readinessInterval.trim() || 1000),
      }
    }
    if (Object.keys(o).length) services[name] = o
  }
  if (Object.keys(services).length) overrides.services = services
  // front-door: body value + completion timing
  const frontDoor: Record<string, unknown> = {}
  const body = parseJsonObject(s.bodyTemplate)
  if (body.ok && body.value) frontDoor.request = { bodyTemplate: body.value }
  const completion: Record<string, number> = {}
  if (s.completionTimeout.trim()) completion.timeoutMs = Number(s.completionTimeout)
  if (s.completionInterval.trim()) completion.intervalMs = Number(s.completionInterval)
  if (Object.keys(completion).length) frontDoor.completion = completion
  if (Object.keys(frontDoor).length) overrides.frontDoor = frontDoor
  // target extension ref
  if (s.targetExtensionRef.trim())
    overrides.target = { extension: { ref: s.targetExtensionRef.trim() } }
  // command env/params
  const cmdEnv = envRowsToSpec(s.cmdEnvRows)
  if (Object.keys(cmdEnv).length) overrides.env = cmdEnv
  const cmdParams = kvLines(s.cmdParams)
  if (Object.keys(cmdParams).length) overrides.params = cmdParams
  return Object.keys(overrides).length ? overrides : undefined
}

// Assemble the instance spec (template reference + pins + overrides). overrides is included only when non-empty.
export function buildInstance(s: InstanceState): Record<string, unknown> {
  const pins: Record<string, string> = {}
  for (const p of s.pins) if (p.slot.trim() && p.value.trim()) pins[p.slot.trim()] = p.value.trim()
  const overrides = buildOverrides(s)
  return {
    template: { id: s.templateId, version: s.templateVersion },
    id: s.templateId, // instance id = template id (convention)
    version: s.version,
    ...(s.description.trim() ? { description: s.description.trim() } : {}),
    pins,
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
  },
  traceMapping: {},
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
function serviceOverridesFromSpec(ov: Record<string, unknown>): ServiceOverrideRow[] {
  const services = asObj(ov.services)
  if (!services) return []
  return Object.entries(services).map(([service, raw]) => {
    const o = asObj(raw) ?? {}
    const res = asObj(o.resources) ?? {}
    const rd = asObj(o.readiness) ?? {}
    return {
      service,
      env: envRowsFromSpec(o.env),
      replicas: numStr(o.replicas),
      cpu: numStr(res.cpu),
      memoryMb: numStr(res.memoryMb),
      volumes: Array.isArray(o.volumes) ? o.volumes.map(asStr).filter(Boolean).join('\n') : '',
      readinessTimeout: numStr(rd.timeoutMs),
      readinessInterval: numStr(rd.intervalMs),
    }
  })
}

export function instanceStateFromSpec(
  inst: {
    template: { id: string; version: string }
    id: string
    version: string
    pins: Record<string, string>
    overrides?: Record<string, unknown>
  },
  slots?: string[]
): InstanceState {
  const rows: PinRow[] =
    slots && slots.length > 0
      ? slots.map((slot) => ({ slot, value: inst.pins[slot] ?? '' }))
      : Object.entries(inst.pins).map(([slot, value]) => ({ slot, value }))
  const ov = inst.overrides ?? {}
  const fd = asObj(ov.frontDoor)
  const body = asObj(asObj(fd?.request)?.bodyTemplate)
  const completion = asObj(fd?.completion)
  const ext = asObj(asObj(ov.target)?.extension)
  return {
    templateId: inst.template.id,
    templateVersion: inst.template.version,
    version: '',
    description: '', // a new version gets a new changelog — it does not inherit the previous version's description (same spirit as version tags)
    pins: rows.length > 0 ? rows : [{ slot: '', value: '' }],
    serviceOverrides: serviceOverridesFromSpec(ov),
    bodyTemplate: body ? JSON.stringify(body, null, 2) : '',
    completionTimeout: numStr(completion?.timeoutMs),
    completionInterval: numStr(completion?.intervalMs),
    targetExtensionRef: asStr(ext?.ref),
    cmdEnvRows: envRowsFromSpec(ov.env),
    cmdParams: kvToLines(ov.params),
  }
}

export { EMPTY_SERVICE_OVERRIDE }
