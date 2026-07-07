import { z } from 'zod'

// GET /harnesses response: the instance surface — versions grouped by template id + list meta (registrant/timestamps/derivation).
// Content (category/kind/subtitle) comes from the latest instance, creator·timestamps from the registration history (control plane HarnessListEntry mirror).
export const harnessSchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
  latestVersion: z.string().optional(),
  versionCount: z.number().optional(),
  category: z.string().optional(), // template category of the latest instance (cli-agent, etc.)
  kind: z.string().optional(), // command | service | process
  subtitle: z.string().optional(), // model/command/service summary (a harness has no free-text description, so used as a subtitle)
  private: z.boolean().optional(), // references a personal (user) secret → only createdBy can view (private)
  createdBy: z.string().optional(), // subject of the first registered instance (none for seed/_shared)
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  // version → free-form labels (only versions that have tags) — mutable meta outside the spec. Attached when versions are hard to tell apart by number alone.
  versionTags: z.record(z.string(), z.array(z.string())).optional(),
})
export type Harness = z.infer<typeof harnessSchema>

export const harnessesSchema = z.array(harnessSchema)

// GET /harnesses/:id response: one harness's instance version list (registration order/semver) + per-version tags (only versions that have them).
export const harnessVersionsSchema = z.object({
  id: z.string(),
  versions: z.array(z.string()),
  versionTags: z.record(z.string(), z.array(z.string())).optional(),
})
export type HarnessVersions = z.infer<typeof harnessVersionsSchema>

// --- client mirror of the resolved HarnessSpec (GET /harnesses/:id/:version) ---
// The final form after the control plane resolves template + pins. The web couples over HTTP only (no core package dependency).

// env value — a literal string or a workspace secret reference ({ secretRef }). Control plane EnvValueSchema mirror.
// For a reference the spec holds only the name; the value is injected just before execution (no plaintext stored in the registry).
export const envValueSchema = z.union([z.string(), z.object({ secretRef: z.string() })])
export type EnvValue = z.infer<typeof envValueSchema>

// env value display text — a literal as-is, a secret reference as "name · secret" (the value is never exposed).
// secretLabel = the secret suffix (localized — the caller passes t('secretLabel'); the default is Korean).
export const envValueText = (v: EnvValue, secretLabel: string = '시크릿'): string =>
  typeof v === 'string' ? v : `${v.secretRef} · ${secretLabel}`

// trace source — the eval pulls the trace the harness exported to OTel/MLflow.
export const traceSourceSchema = z.object({
  kind: z.enum(['otel', 'mlflow']),
  endpoint: z.string(),
})
export type TraceSource = z.infer<typeof traceSourceSchema>

// service readiness polling — the ceiling/interval until HTTP responds (unset = runtime default).
export const serviceReadinessSchema = z.object({
  timeoutMs: z.number(),
  intervalMs: z.number(),
})
export type ServiceReadiness = z.infer<typeof serviceReadinessSchema>

// topology service — perRun = per-case key names injected at runtime. env = static env (non-store config),
// volumes = docker -v mounts, readiness = polling ceiling. All three are info the harness actually uses, so exposed in the detail view.
export const topologyServiceSchema = z.object({
  name: z.string(),
  image: z.string(),
  port: z.number().optional(),
  needs: z.array(z.string()).default([]),
  perRun: z.array(z.string()).default([]),
  replicas: z.number().default(1),
  env: z.record(z.string(), envValueSchema).default({}),
  volumes: z.array(z.string()).optional(),
  readiness: serviceReadinessSchema.optional(),
})
export type TopologyService = z.infer<typeof topologyServiceSchema>

// dependency store — shared + per-case logical isolation (isolateBy = the kind of isolation key).
// isolateBy="external" = BYO external/shared store (a different cluster, etc.; not deployed by Everdict, connection via env at deploy time). service = the service that uses it.
export const topologyDependencySchema = z.object({
  store: z.string(), // postgres | redis | minio
  role: z.string(),
  isolateBy: z.string(), // thread_id | key-prefix | object-prefix | schema | external
  service: z.string().optional(), // the service that uses this store (unset = shared across the topology)
})
export type TopologyDependency = z.infer<typeof topologyDependencySchema>

// target environment (II) — the world the agent acts on (browser/OS). The grader's observation target.
export const topologyTargetSchema = z.object({
  kind: z.string(), // browser
  engine: z.string().optional(), // chromium
  extension: z.object({ ref: z.string() }).optional(),
  lifecycle: z.string().optional(),
  observe: z.array(z.string()).default([]),
  // observation delivery mode — reference (store-fetch, default) | sentinel (inline retrieval, path=extraction dot-path) | egress (sink push).
  delivery: z
    .object({ mode: z.string(), path: z.string().optional(), sink: z.string().optional() })
    .optional(),
})
export type TopologyTarget = z.infer<typeof topologyTargetSchema>

// front door — the entry point where the eval driver submits a case.
export const frontDoorSchema = z.object({
  service: z.string(),
  submit: z.string(),
  trace: z.string().optional(),
})
export type FrontDoor = z.infer<typeof frontDoorSchema>

// trace extraction for a command harness: none (result only) | OTel/MLflow pull.
export const commandTraceSchema = z.object({
  kind: z.enum(['none', 'otel', 'mlflow']),
  endpoint: z.string().optional(),
})
export type CommandTrace = z.infer<typeof commandTraceSchema>

// full resolved HarnessSpec (process | service | command) — loose mirror for display (the rest passthrough).
export const harnessSpecSchema = z
  .object({
    kind: z.enum(['process', 'service', 'command']),
    id: z.string(),
    version: z.string(),
    // service (topology)
    services: z.array(topologyServiceSchema).optional(),
    dependencies: z.array(topologyDependencySchema).optional(),
    target: topologyTargetSchema.optional(),
    frontDoor: frontDoorSchema.optional(),
    traceSource: traceSourceSchema.optional(),
    // command (declarative CLI)
    image: z.string().optional(),
    workDir: z.string().optional(),
    setup: z.array(z.string()).optional(),
    command: z.string().optional(),
    env: z.record(z.string(), envValueSchema).optional(),
    model: z.string().optional(),
    trace: commandTraceSchema.optional(),
  })
  .passthrough()
export type HarnessSpec = z.infer<typeof harnessSpecSchema>
export type HarnessKind = HarnessSpec['kind']

// --- raw config (pre-resolve original) — for the detail config view + prefilling new-version edits ---

// instance variation (overrides) — structure-invariant behavior deltas (service env/resources/replicas/volumes/readiness · front-door
// body/completion · target ext · command env/params). The web round-trips as raw JSON (editor = JSON textarea) +
// config panel display. The control plane does the final schema validation, so this is a loose mirror.
export const harnessOverridesSchema = z.record(z.string(), z.unknown())
export type HarnessOverrides = z.infer<typeof harnessOverridesSchema>

// raw instance (GET /harnesses/:id/:version/instance): template reference + pins (slot→value) + overrides (variation).
export const harnessInstanceSpecSchema = z.object({
  template: z.object({ id: z.string(), version: z.string() }),
  id: z.string(),
  version: z.string(),
  description: z.string().optional(), // this version's changelog (free text) — shown in the detail view
  pins: z.record(z.string(), z.string()).default({}),
  overrides: harnessOverridesSchema.optional(),
})
export type HarnessInstanceSpec = z.infer<typeof harnessInstanceSpecSchema>

// template service — an image-less slot (if slot is unset, name is the slot). env/volumes/readiness are part of the structure (not pin targets).
export const templateServiceSchema = z.object({
  name: z.string(),
  slot: z.string().optional(),
  port: z.number().optional(),
  needs: z.array(z.string()).default([]),
  perRun: z.array(z.string()).default([]),
  replicas: z.number().default(1),
  env: z.record(z.string(), envValueSchema).default({}),
  volumes: z.array(z.string()).optional(),
  readiness: serviceReadinessSchema.optional(),
})
export type TemplateService = z.infer<typeof templateServiceSchema>

// template (category) structure (GET /harness-templates/:id/:version) — loose passthrough mirror.
export const harnessTemplateSpecSchema = z
  .object({
    kind: z.enum(['process', 'service', 'command']),
    category: z.string(),
    id: z.string(),
    version: z.string(),
    // service (topology)
    services: z.array(templateServiceSchema).optional(),
    dependencies: z.array(topologyDependencySchema).optional(),
    target: topologyTargetSchema.optional(),
    frontDoor: frontDoorSchema.optional(),
    traceSource: traceSourceSchema.optional(),
    // command (declarative CLI) — image/model are defaults the instance can pin.
    image: z.string().optional(),
    workDir: z.string().optional(),
    setup: z.array(z.string()).optional(),
    command: z.string().optional(),
    env: z.record(z.string(), envValueSchema).optional(),
    model: z.string().optional(),
    trace: commandTraceSchema.optional(),
  })
  .passthrough()
export type HarnessTemplateSpec = z.infer<typeof harnessTemplateSpecSchema>

// the template's pinnable slot names — service=service slots, command=image/model, process=none.
export function templateSlotNames(tpl: HarnessTemplateSpec): string[] {
  if (tpl.kind === 'service') return (tpl.services ?? []).map((s) => s.slot ?? s.name)
  if (tpl.kind === 'command') return ['image', 'model']
  return []
}
