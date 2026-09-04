import type {
  CapabilityRecord as ContractCapabilityRecord,
  CapabilitySpecDiff as ContractCapabilitySpecDiff,
  EnvironmentPreset,
  ModelBinding,
} from '@everdict/contracts'
import { z } from 'zod'

// Capability Store — one discriminated entity (mcp|code|skill|environment) a member authors and publishes, and another member
// adopts (the tool kinds) or consumes while authoring a harness (environment). Boundary validation lives only in this zod v4, and the
// EXPORTED types are pinned to @everdict/contracts (P4). `import type` only — the contract's zod v3 schemas do not run in the web.

// Four levels of reach. subset = some of the author's own workspaces (sharedWith); public = visible to everyone (admin-gated).
export const capabilityVisibilitySchema = z.enum(['private', 'workspace', 'subset', 'public'])
export type CapabilityVisibility = z.infer<typeof capabilityVisibilitySchema>

export const capabilityTypeSchema = z.enum(['mcp', 'code', 'skill', 'environment', 'delegation'])
export type CapabilityType = z.infer<typeof capabilityTypeSchema>

// What an adopter must fill with their own secrets — name and description only, never a value.
const requiredSecretSchema = z.object({ name: z.string(), description: z.string() })

// The discriminated spec — a capability is exactly one of the kinds.
// mcp — two transports: remote HTTP (`url`) or container stdio (`image`, `docker run -i`). Exactly one (enforced at the contract's storage boundary).
// The effect contract (O4) — what happens to the world OUTSIDE the sandbox when this tool is called. A tool that can write is
// REQUIRED by the control plane's domain guard to declare one (assertCapabilityEffects), and the agent permission gate judges risk
// from this declaration rather than from a name (effectsRequireConsent). A rollback is either a string (older compatibility) or a tagged shape.
export const rollbackPlanSchema = z.union([
  z.string(),
  z.object({ kind: z.literal('capability'), capability: z.string() }),
  z.object({ kind: z.literal('compensation'), description: z.string() }),
  z.object({ kind: z.literal('irreversible'), requiresApproval: z.literal(true) }),
])
export type RollbackPlan = z.infer<typeof rollbackPlanSchema>

export const effectContractSchema = z.object({
  sideEffect: z.enum(['none', 'workspace', 'external']),
  idempotent: z.boolean().optional(),
  rollback: rollbackPlanSchema.optional(),
  partialFailure: z.string().optional(),
  // What it SAW (reads) and where that can go (egress) — an axis `sideEffect` does not express. A read-only tool is sensitive too
  // when it can send outward.
  dataAccess: z
    .object({
      reads: z.enum(['none', 'workspace', 'external']).optional(),
      egress: z.enum(['none', 'workspace', 'external']).optional(),
    })
    .optional(),
})
export type EffectContract = z.infer<typeof effectContractSchema>

const mcpToolSpecSchema = z.object({
  type: z.literal('mcp'),
  url: z.string().optional(),
  image: z.string().optional(),
  args: z.array(z.string()),
  provides: z.array(z.string()),
  requiredSecrets: z.array(requiredSecretSchema),
  write: z.boolean(),
  effects: effectContractSchema.optional(),
})
// A code tool's worked examples — used three ways: the store detail, the try runner, and the agent tool description (showing the input shape as a real call).
export const codeToolExampleSchema = z.object({
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  note: z.string().optional(),
})
export type CodeToolExample = z.infer<typeof codeToolExampleSchema>

const codeToolSpecSchema = z.object({
  type: z.literal('code'),
  language: z.enum(['python', 'node']),
  code: z.string(),
  parametersSchema: z.record(z.string(), z.unknown()),
  isReadOnly: z.boolean(),
  requiredSecrets: z.array(requiredSecretSchema),
  timeoutSec: z.number().optional(),
  image: z.string().optional(),
  examples: z.array(codeToolExampleSchema),
  effects: effectContractSchema.optional(),
})
const skillCapabilitySpecSchema = z.object({
  type: z.literal('skill'),
  instructions: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
})

// environment — an evaluation-environment image asset (docs/architecture/environment-image-store.md). A preset is deep topology sub-vocabulary,
// so the runtime shallow-checks it only (the control plane validates and serves it against the real schema, following the traceEvent passthrough), with the type anchored to the contract.
const environmentContentsSchema = z.object({
  benchmark: z.string().optional(),
  packages: z.array(z.string()),
  os: z.string().optional(),
  arch: z.string().optional(),
})
const environmentPresetSchema = z.custom<EnvironmentPreset>(
  (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
)
const environmentImageSpecSchema = z.object({
  type: z.literal('environment'),
  image: z.string(),
  contents: environmentContentsSchema.optional(),
  preset: environmentPresetSchema.optional(),
  instructions: z.string(),
})

// delegation — the work environment everdict hands work to. WHICH conversational agent, in WHICH image, under WHICH model/env and
// under WHICH standing instructions, defined once and delegated to by reference only (capability-store.md §Fifth kind).
// An env value is a literal or {secretRef} — mirroring the control plane's EnvValueSchema (the web only displays it, never rebuilds it).
const delegationEnvValueSchema = z.union([
  z.string(),
  z.object({ secretRef: z.string(), scope: z.enum(['user', 'workspace']).optional() }),
])
const delegationProfileSpecSchema = z.object({
  type: z.literal('delegation'),
  harness: z.object({ id: z.string(), version: z.string().optional() }),
  image: z.string(),
  model: z
    .custom<ModelBinding>((v) => typeof v === 'string' || (typeof v === 'object' && v !== null))
    .optional(),
  env: z.record(z.string(), delegationEnvValueSchema),
  workDir: z.string().optional(),
  instructions: z.string(),
  instructionsFile: z.string(),
  ttlSec: z.number().optional(),
})

export const capabilitySpecSchema = z.discriminatedUnion('type', [
  mcpToolSpecSchema,
  codeToolSpecSchema,
  skillCapabilitySpecSchema,
  environmentImageSpecSchema,
  delegationProfileSpecSchema,
])
export type CapabilitySpec = z.infer<typeof capabilitySpecSchema>

// GET /capabilities · /capabilities/public · /capabilities/:id — the whole CapabilityRecord
// plus (for the environment kind only) an imageClass annotation against the VIEWER's workspace registry (computed by the control plane, not persisted, following P1g).
export const capabilityImageClassSchema = z.enum([
  'managed',
  'workspace',
  'external',
  'local',
  'unqualified',
])
export type CapabilityImageClass = z.infer<typeof capabilityImageClassSchema>
export const capabilitySchema = z.object({
  id: z.string(),
  tenant: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  spec: capabilitySpecSchema,
  visibility: capabilityVisibilitySchema,
  sharedWith: z.array(z.string()),
  tags: z.array(z.string()),
  createdBy: z.string(),
  createdAt: z.string(),
  imageClass: capabilityImageClassSchema.optional(),
})
export const capabilitiesSchema = z.array(capabilitySchema)
export type Capability = z.infer<typeof capabilitySchema>

// PUT /capabilities/:id 200 — the save result (the assigned version) plus (environment) image classification warnings (warn, not block).
export const saveCapabilityResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  created: z.boolean(),
  imageWarnings: z.array(z.object({ image: z.string(), class: z.string() })).optional(),
})
export type SaveCapabilityResult = z.infer<typeof saveCapabilityResultSchema>

// POST /capabilities/validate 200 — the save dry-run: a spec parse failure (ok:false), or the predicted version plus image warnings (ok:true).
export const validateCapabilityResultSchema = z.union([
  z.object({ ok: z.literal(false), errors: z.array(z.string()) }),
  z.object({
    ok: z.literal(true),
    id: z.string(),
    type: capabilityTypeSchema,
    willCreate: z.boolean(),
    version: z.string(),
    existingVersions: z.array(z.string()),
    imageWarnings: z.array(z.object({ image: z.string(), class: z.string() })).optional(),
  }),
])
export type ValidateCapabilityResult = z.infer<typeof validateCapabilityResultSchema>

// POST /capabilities/probe-mcp 200 — the mcp connection test: reachability plus the discovered tools (to fill `provides`). A failure is a RESULT (reachable:false).
export const probeCapabilityMcpResultSchema = z.object({
  reachable: z.boolean(),
  detail: z.string(),
  reason: z.enum(['auth', 'unreachable', 'protocol']).optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
})
export type ProbeCapabilityMcpResult = z.infer<typeof probeCapabilityMcpResultSchema>

// GET /workspace/image-registries/tags — the tag list for the environment image picker.
export const imageTagsSchema = z.object({
  registry: z.string(),
  repository: z.string(),
  tags: z.array(z.string()),
})
export type ImageTags = z.infer<typeof imageTagsSchema>

// GET /workspace/image-registries/verify — a real pull verification at authoring time. Unlike the static classification warnings
// (imageWarnings) this is what the registry actually ANSWERED, and a digest that comes back is a reproducible pin. A failure is a 200 result too (pullable:false + reason).
export const imageVerifySchema = z.object({
  pullable: z.boolean(),
  reason: z.enum(['ok', 'auth', 'not-found', 'unreachable', 'unregistered-host']),
  digest: z.string().optional(),
})
export type ImageVerify = z.infer<typeof imageVerifySchema>

// POST /agent/code-tools/try 200 — the code tool verification result. check = syntax (parse only) · run = actually executing the example input
// (the same execution contract and sandbox gate as the agent). Stateless and not persisted (isomorphic to the skill try, so a local shape with no contract anchor).
export const codeToolTryResultSchema = z.object({
  mode: z.enum(['check', 'run']),
  ok: z.boolean(),
  content: z.string(),
  durationMs: z.number(),
  missingSecrets: z.array(z.string()),
})
export type CodeToolTryResult = z.infer<typeof codeToolTryResultSchema>

// GET /capabilities/:id/versions — the live versions this workspace can see (ascending) plus a version → tag display map.
// `source` = the owning workspace (mine, or the cross-tenant public/subset owner). An API-only response, so no contract anchor.
export const capabilityVersionsSchema = z.object({
  id: z.string(),
  source: z.string(),
  versions: z.array(z.string()),
  versionTags: z.record(z.string(), z.array(z.string())),
})
export type CapabilityVersions = z.infer<typeof capabilityVersionsSchema>

// GET /capabilities/:id/diff — the structural diff of two versions' immutable content (name/description/spec). The type is pinned to the contract (a drift guard).
const capabilityFieldChangeSchema = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
  change: z.enum(['added', 'removed', 'changed']),
})
export type CapabilityFieldChange = z.infer<typeof capabilityFieldChangeSchema>
export const capabilitySpecDiffSchema = z.object({
  id: z.string(),
  base: z.string(),
  candidate: z.string(),
  typeChanged: z.boolean(),
  changes: z.array(capabilityFieldChangeSchema),
  summary: z.object({
    added: z.number().int(),
    removed: z.number().int(),
    changed: z.number().int(),
  }),
})
export type CapabilitySpecDiff = z.infer<typeof capabilitySpecDiffSchema>

// The drift guard — the record is checked in BOTH directions (a change to a field on either side breaks the web typecheck).
type AssertAssignable<A extends B, B> = A
type _CapFwd = AssertAssignable<Capability, ContractCapabilityRecord>
type _CapBack = AssertAssignable<ContractCapabilityRecord, Capability>
type _DiffFwd = AssertAssignable<CapabilitySpecDiff, ContractCapabilitySpecDiff>
type _DiffBack = AssertAssignable<ContractCapabilitySpecDiff, CapabilitySpecDiff>
