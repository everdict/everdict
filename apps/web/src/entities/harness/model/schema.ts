import type {
  HarnessListEntry,
  HarnessSpecDiffResponse,
  HarnessVersionsResponse,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED list/versions types are anchored to
// @everdict/contracts (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// The full resolved/template/instance HarnessSpec mirrors below stay LOCAL (loose display views — see the note
// at the resolved-spec section): the contract HarnessSpec / HarnessTemplateSpec are DISCRIMINATED UNIONS and the
// instance's `overrides` is a structured shape the web flattens to a loose record, so they can't be anchored.

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

export const harnessesSchema = z.array(harnessSchema)

// GET /harnesses/:id response: one harness's instance version list (registration order/semver) + per-version tags (only versions that have them).
export const harnessVersionsSchema = z.object({
  id: z.string(),
  versions: z.array(z.string()),
  versionTags: z.record(z.string(), z.array(z.string())).optional(),
})

// GET /harnesses/:id/diff response: structural config diff of two resolved versions — one leaf field change per path.
// change = added (only in candidate) | removed (only in base) | changed (value differs). before/after are display strings.
export const harnessFieldChangeSchema = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
  change: z.enum(['added', 'removed', 'changed']),
})
export type HarnessFieldChange = z.infer<typeof harnessFieldChangeSchema>

export const harnessSpecDiffSchema = z.object({
  id: z.string(),
  base: z.string(),
  candidate: z.string(),
  kindChanged: z.boolean(), // process ↔ command ↔ service kind change (whole-spec restructure)
  changes: z.array(harnessFieldChangeSchema),
  summary: z.object({
    added: z.number(),
    removed: z.number(),
    changed: z.number(),
  }),
})

// Drift guards.
// Harness (list summary) is a NARROWER view of the wire HarnessListEntry: the web models latestVersion/
// versionCount as OPTIONAL (the wire requires them) and omits latestCreatedBy, so it can't guard forward
// (web ⊄ wire). The Pick-reverse guard requires every field the web DOES model to exist on the wire with an
// assignable type — catching a rename/retype of one of those fields.
// HarnessVersions is identical-shape to the wire versions DTO — bidirectional.
type AssertAssignable<A extends B, B> = A
type WebHarness = z.infer<typeof harnessSchema>
type WebHarnessVersions = z.infer<typeof harnessVersionsSchema>
type WebHarnessSpecDiff = z.infer<typeof harnessSpecDiffSchema>
type _harnessFieldsOnWire = AssertAssignable<Pick<HarnessListEntry, keyof WebHarness>, WebHarness>
type _versionsFwd = AssertAssignable<WebHarnessVersions, HarnessVersionsResponse>
type _versionsBack = AssertAssignable<HarnessVersionsResponse, WebHarnessVersions>
// HarnessSpecDiff is identical-shape to the wire diff DTO — guarded bidirectionally.
type _diffFwd = AssertAssignable<WebHarnessSpecDiff, HarnessSpecDiffResponse>
type _diffBack = AssertAssignable<HarnessSpecDiffResponse, WebHarnessSpecDiff>

// Harness keeps the web's narrower shape (anchored by the Pick-reverse guard); HarnessVersions/HarnessSpecDiff alias the wire.
export type Harness = WebHarness
export type HarnessVersions = HarnessVersionsResponse
export type HarnessSpecDiff = HarnessSpecDiffResponse

export type __harnessSummaryDriftGuard = [
  _harnessFieldsOnWire,
  _versionsFwd,
  _versionsBack,
  _diffFwd,
  _diffBack,
]

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
// A service's agent-server model binding — a bare registered-Model id (the web wizard writes only this shape;
// object ModelRef bindings come via API/MCP). Loose display mirror; the connection env is injected at dispatch.
export const modelBindingSchema = z.union([z.string(), z.object({ ref: z.string() }).passthrough()])

export const topologyServiceSchema = z.object({
  name: z.string(),
  image: z.string(),
  port: z.number().optional(),
  needs: z.array(z.string()).default([]),
  perRun: z.array(z.string()).default([]),
  replicas: z.number().default(1),
  model: modelBindingSchema.optional(),
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
    // Served provenance classification (P1g) — per image, computed by the control plane against ALL
    // workspace registries. Replaces the deleted client-side classifyImageRef mirror.
    imageClasses: z
      .array(
        z.object({
          image: z.string(),
          class: z.enum(['workspace', 'external', 'local', 'unqualified']),
        })
      )
      .optional(),
  })
  .passthrough()
export type HarnessSpec = z.infer<typeof harnessSpecSchema>
export type ImageRefClass = NonNullable<HarnessSpec['imageClasses']>[number]['class']
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
  model: modelBindingSchema.optional(),
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
