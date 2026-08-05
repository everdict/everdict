import type { SpanAttrMapping } from '@everdict/contracts'
import type {
  HarnessListEntry,
  HarnessSpecDiffResponse,
  HarnessTemplateListEntry,
  HarnessVersionsResponse,
} from '@everdict/contracts/wire'
import { z } from 'zod'

import { versionOriginsSchema } from '@/entities/capability-origin'

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
  // The owning team (mig 0106). It decides who may CHANGE this and — for a private team — who sees it at
  // all, and it is re-fileable (`POST /<resource>/:id/team`), so the detail shows it and offers the move.
  // Absent = unowned (a `_shared` entry, or one from before the axis), which is the workspace's.
  teamId: z.string().optional(),
  versions: z.array(z.string()),
  latestVersion: z.string().optional(),
  versionCount: z.number().optional(),
  category: z.string().optional(), // template category of the latest instance (cli-agent, etc.)
  // 최신 인스턴스가 올라탄 형상(템플릿). 같은 템플릿의 변형끼리 목록에서 묶는 근거 — 이게 없으면
  // env 하나만 다른 변형도 서로 무관한 하네스로 읽힌다.
  templateId: z.string().optional(),
  templateVersion: z.string().optional(),
  // 최신 인스턴스가 그 형상에서 무엇을 바꿨는가 — 한 템플릿에 하네스가 여럿일 때 "이건 어느 쪽인가"에 답한다.
  // 제어 평면이 델타에서 파생하므로 손으로 쓴 설명처럼 낡지 않는다.
  variation: z.array(z.object({ scope: z.string().optional(), label: z.string() })).optional(),
  kind: z.string().optional(), // command | service | process
  subtitle: z.string().optional(), // model/command/service summary (a harness has no free-text description, so used as a subtitle)
  private: z.boolean().optional(), // references a personal (user) secret → only createdBy can view (private)
  createdBy: z.string().optional(), // subject of the first registered instance (none for seed/_shared)
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  // version → free-form labels (only versions that have tags) — mutable meta outside the spec. Attached when versions are hard to tell apart by number alone.
  versionTags: z.record(z.string(), z.array(z.string())).optional(),
  // version → 그 버전이 어디서 왔는가(찍힌 버전만). 이슈에서 태어났는지, 어떤 에이전트가 어느 대화에서
  // 만들었는지 — 상세가 리니지를 그리는 근거.
  versionOrigins: versionOriginsSchema.optional(),
})

export const harnessesSchema = z.array(harnessSchema)

// GET /harness-templates: 이 워크스페이스가 고를 수 있는 형상 목록(+ _shared). 인스턴스 폼의 템플릿 피커와
// 형상 카탈로그가 읽는다. 아직 아무 하네스도 올라타지 않은 형상은 이 목록에만 나오므로, 무엇인지도 여기 실려야 한다.
export const harnessTemplateSchema = z.object({
  id: z.string(),
  versions: z.array(z.string()),
  owner: z.string(),
  latestVersion: z.string().optional(),
  kind: z.string().optional(),
  category: z.string().optional(),
  serviceCount: z.number().optional(),
})
export const harnessTemplatesSchema = z.array(harnessTemplateSchema)
export type HarnessTemplate = z.infer<typeof harnessTemplateSchema>

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
// 템플릿 목록 엔트리는 동일 형태 — 양방향으로 묶는다.
type WebHarnessTemplate = z.infer<typeof harnessTemplateSchema>
type _tplFwd = AssertAssignable<WebHarnessTemplate, HarnessTemplateListEntry>
type _tplBack = AssertAssignable<HarnessTemplateListEntry, WebHarnessTemplate>

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
  _tplFwd,
  _tplBack,
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

// One evidence selector — an attr key + an optional dot/bracket path INTO its JSON value. A bare string = { key }.
export const evidenceSelectorSchema = z.object({
  key: z.string(),
  path: z.string().optional(),
  pick: z.enum(['last', 'first']).optional(),
})
export const evidenceSlotSchema = z.array(z.union([z.string(), evidenceSelectorSchema]))

// Contract-faithful SpanAttrMapping mirror (drift-guarded below; evidence keys relaxed to a bare string —
// a superset, the control plane enforces the name rules). The former "loose record" (string[] values only)
// was in fact STRICTER than the contract: it rejected evidence-selector objects and the `evidence` record,
// so a harness registered with those failed to load in the web at all.
export const spanAttrMappingSchema = z.object({
  model: z.array(z.string()).optional(),
  inputTokens: z.array(z.string()).optional(),
  outputTokens: z.array(z.string()).optional(),
  costUsd: z.array(z.string()).optional(),
  toolName: z.array(z.string()).optional(),
  toolCallId: z.array(z.string()).optional(),
  toolArgs: z.array(z.string()).optional(),
  toolResult: z.array(z.string()).optional(),
  messageText: z.array(z.string()).optional(),
  finalAnswer: evidenceSlotSchema.optional(),
  dom: evidenceSlotSchema.optional(),
  screenshot: evidenceSlotSchema.optional(),
  evidence: z.record(z.string(), evidenceSlotSchema).optional(),
})
type _spanAttrMappingFwd = AssertAssignable<z.infer<typeof spanAttrMappingSchema>, SpanAttrMapping>
type _spanAttrMappingBack = AssertAssignable<SpanAttrMapping, z.infer<typeof spanAttrMappingSchema>>
export type __harnessMappingDriftGuard = [_spanAttrMappingFwd, _spanAttrMappingBack]

// trace source — the eval pulls the trace the harness exported to its observability platform (5 kinds).
// Loose display mirror (kind is a plain string; the control plane validates the exact enum). authSecret is a
// SecretStore key NAME; correlate/service/project are how the platform locates this run's trace.
export const traceSourceSchema = z.object({
  kind: z.string(),
  endpoint: z.string(),
  authSecret: z.string().optional(),
  correlate: z.string().optional(),
  service: z.string().optional(),
  project: z.string().optional(),
  artifactBaseUrl: z.string().optional(), // base for root-relative evidence artifact refs (else judges get path strings)
  // Per-harness span→TraceEvent attribute overrides — the full SpanAttrMapping shape (incl. evidence slots);
  // absent = OTel GenAI conventions.
  mapping: spanAttrMappingSchema.optional(),
})
export type TraceSource = z.infer<typeof traceSourceSchema>

// service readiness polling — the ceiling/interval until HTTP responds (unset = runtime default).
export const serviceReadinessSchema = z.object({
  timeoutMs: z.number(),
  intervalMs: z.number(),
})
export type ServiceReadiness = z.infer<typeof serviceReadinessSchema>

// service resource request — cpu (1000 = 1 vCPU, k8s millicore convention) · memoryMb · gpu. 인스턴스가 덮어쓸 수 있는
// 값이라 템플릿 쪽에서도 읽어야 한다(상속값 표시의 근거) — 미러에서 빠져 있으면 "상속됨"이 빈칸으로 보인다.
export const serviceResourcesSchema = z.object({
  cpu: z.number().optional(),
  memoryMb: z.number().optional(),
  gpu: z.number().optional(),
})
export type ServiceResources = z.infer<typeof serviceResourcesSchema>

// intrinsic execution requirement — WHAT the service's image needs, never WHERE (not a node label). os = the OS the
// image genuinely requires (a Windows Playwright server needs Windows on ANY infra); it derives to an os-<x> capability
// so the placement gate excludes runtimes without such a node and each runtime realizes it natively (k8s nodeSelector /
// nomad ${attr.kernel.name} / docker declines). Unset / linux = no gate. Loose display mirror (the control plane validates the exact enum).
export const serviceRequiresSchema = z.object({
  os: z.string().optional(),
})
export type ServiceRequires = z.infer<typeof serviceRequiresSchema>

// topology service — perRun = per-case key names injected at runtime. env = static env (non-store config),
// volumes = docker -v mounts, readiness = polling ceiling. All three are info the harness actually uses, so exposed in the detail view.
// A service's agent-server model binding — a bare registered-Model id (the web wizard writes only this shape;
// object ModelRef bindings come via API/MCP). Loose display mirror; the connection env is injected at dispatch.
export const modelBindingSchema = z.union([z.string(), z.object({ ref: z.string() }).passthrough()])

// Peer wiring — inject a needs-peer's resolved address into a service's env under BYO variable names (for third-party
// images that expect a specific env var). The one PORTABLE alternative to a hardcoded host; the runtime fills the
// per-backend address. service must be a declared peer in needs (portability lint enforces).
export const serviceWiringSchema = z.object({
  service: z.string(),
  hostEnv: z.string().optional(),
  portEnv: z.string().optional(),
  urlEnv: z.string().optional(),
})
export type ServiceWiring = z.infer<typeof serviceWiringSchema>

// How the service is realized — "container" (default; runs `image`) | "host" (no container: `command` runs directly
// on the node, Nomad raw_exec). Loose display mirror (the control plane validates the pairing rules).
export const serviceExecSchema = z.object({
  kind: z.string(),
  command: z.array(z.string()).optional(),
  artifact: z.string().optional(),
})
export type ServiceExec = z.infer<typeof serviceExecSchema>

export const topologyServiceSchema = z.object({
  name: z.string(),
  image: z.string().optional(), // absent for a host-exec service (exec.kind "host" — it runs no container)
  port: z.number().optional(),
  needs: z.array(z.string()).default([]),
  perRun: z.array(z.string()).default([]),
  replicas: z.number().default(1),
  model: modelBindingSchema.optional(),
  env: z.record(z.string(), envValueSchema).default({}),
  volumes: z.array(z.string()).optional(),
  readiness: serviceReadinessSchema.optional(),
  resources: serviceResourcesSchema.optional(),
  wiring: z.array(serviceWiringSchema).optional(),
  requires: serviceRequiresSchema.optional(), // intrinsic OS need → node placement (windows/macos; linux = default, no gate)
  exec: serviceExecSchema.optional(), // host-exec realization (no container) — display passthrough
})
export type TopologyService = z.infer<typeof topologyServiceSchema>

// BYO env mapping of a dependency store — env = the key the service image reads (e.g. VALKEY_URL), template = an
// optional {field} recomposition of the deployed store's coordinates (unset = the canonical {url}). Rendered by the
// runtime from the store it actually deployed, so one mapping works on every runtime/isolation model.
export const dependencyInjectSchema = z.object({
  env: z.string(),
  template: z.string().optional(),
})
export type DependencyInject = z.infer<typeof dependencyInjectSchema>

// dependency store — shared + per-case logical isolation (isolateBy = the kind of isolation key).
// isolateBy="external" = BYO external/shared store (a different cluster, etc.; not deployed by Everdict, connection via env at deploy time). service = the service that uses it.
// purpose = the store's role in the eval: "plumbing" (default) = the agent's own state (empty at start) · "data" = a
// world-state store the task operates on, seeded per-case from the dataset (docs/architecture/dependency-store-roles.md).
export const topologyDependencySchema = z.object({
  store: z.string(), // postgres | redis | minio
  role: z.string(),
  purpose: z.enum(['plumbing', 'data']).default('plumbing'),
  isolateBy: z.string(), // thread_id | key-prefix | object-prefix | schema | external
  service: z.string().optional(), // the service that uses this store (unset = shared across the topology)
  inject: z.array(dependencyInjectSchema).optional(), // BYO store env names (scoped by `service` the same way)
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

// front door — the entry point where the eval driver submits a case. 제출 바디와 완료 대기 시간은 인스턴스가
// 덮어쓰는 칸이라 상속값 표시에 필요하다(나머지 필드는 passthrough — 표시용 느슨한 미러).
export const frontDoorSchema = z
  .object({
    service: z.string(),
    submit: z.string(),
    trace: z.string().optional(),
    request: z
      .object({ bodyTemplate: z.record(z.string(), z.unknown()).optional() })
      .passthrough()
      .optional(),
    completion: z
      .object({
        mode: z.string().optional(),
        timeoutMs: z.number().optional(),
        intervalMs: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
export type FrontDoor = z.infer<typeof frontDoorSchema>

// trace extraction for a command harness: none (result only) | file (the command writes its OWN TraceEvent
// stream into the sandbox) | a pull from one of the four observability platforms.
// ⚠️ 이 목록은 계약(`CommandTraceSpecSchema`)의 7종을 그대로 따라야 한다 — 여기 없는 kind 하나가 오면
// `.parse()` 가 스펙 전체를 거절해서 그 하네스의 상세 화면이 "불러오지 못했습니다" 한 줄로 죽는다
// (드리프트 가드는 타입만 잡고 enum 값은 못 잡는다 — 그래서 `file` 하네스가 전부 열리지 않았다).
export const commandTraceSchema = z.object({
  kind: z.enum(['none', 'file', 'otel', 'mlflow', 'langfuse', 'langsmith', 'phoenix']),
  endpoint: z.string().optional(), // 플랫폼에서 끌어오는 kind 만 갖는다
  path: z.string().optional(), // file 만 갖는다 — 샌드박스 workDir 기준 상대 경로
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
          class: z.enum(['managed', 'workspace', 'external', 'local', 'unqualified']),
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
  // store provenance annotation for pins filled from environment capabilities — slot → the environment's identity.
  // The pin value stays the verbatim ref; this only drives the "from store" chip (resolve ignores it).
  pinSources: z
    .record(z.string(), z.object({ source: z.string(), id: z.string(), version: z.string() }))
    .optional(),
  overrides: harnessOverridesSchema.optional(),
})
export type HarnessInstanceSpec = z.infer<typeof harnessInstanceSpecSchema>

// template service — a slot (if slot is unset, name is the slot). env/volumes/readiness are part of the structure
// (not pin targets). image = the slot's DEFAULT, so an instance pins only the services it actually changes.
export const templateServiceSchema = z.object({
  name: z.string(),
  slot: z.string().optional(),
  image: z.string().optional(),
  port: z.number().optional(),
  needs: z.array(z.string()).default([]),
  perRun: z.array(z.string()).default([]),
  replicas: z.number().default(1),
  model: modelBindingSchema.optional(),
  env: z.record(z.string(), envValueSchema).default({}),
  volumes: z.array(z.string()).optional(),
  readiness: serviceReadinessSchema.optional(),
  resources: serviceResourcesSchema.optional(),
  wiring: z.array(serviceWiringSchema).optional(),
  requires: serviceRequiresSchema.optional(), // intrinsic OS need (structure, not a pin target)
  exec: serviceExecSchema.optional(), // host-exec realization (no container, no image pin) — display passthrough
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
    // command 의 {{var}} 기본값 — 인스턴스가 덮어쓰는 칸이라 상속값 표시에 필요하다.
    params: z.record(z.string(), z.string()).optional(),
    resources: serviceResourcesSchema.optional(), // job 단위 자원 요청(command)
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
