import { z } from "zod";
import {
  EnvValueSchema,
  FrontDoorSpecSchema,
  TopologyDependencySchema,
  TopologyServiceSchema,
  TopologyTargetSchema,
} from "../harness/harness-spec.js";
import { ModelBindingSchema } from "../harness/model-spec.js";
import { SkillFilesSchema } from "./skill.js";

// Capability Store contracts — one discriminated `Capability` entity (kind ∈ mcp|code|skill|environment) that a
// workspace's members AUTHOR and PUBLISH at one of four reach tiers, and that a browsing member ADOPTS into their
// agent (tool kinds) or consumes at harness-authoring time (environment). Mirrors the Judge model|harness|code idiom
// (one entity, one `type` discriminant). SSOT: docs/architecture/capability-store.md +
// docs/architecture/environment-image-store.md (the environment kind).

// A capability's reach tier. Extends the private|workspace vocabulary (Views / skills / browser-profiles) with the
// two cross-tenant tiers. `subset` fans a capability across the AUTHOR's OWN workspaces (a chosen subset of the
// workspaces they are a member of — "this skill, in 2 of my 5 workspaces"), NOT a publish to strangers; `public` is
// the real expose-to-everyone tier (admin-gated). workspace = tenant = trust-zone.
export const CapabilityVisibilitySchema = z.enum(["private", "workspace", "subset", "public"]);
export type CapabilityVisibility = z.infer<typeof CapabilityVisibilitySchema>;

// The kind discriminant (also stored as an indexed column for browse-by-type). Derived from `spec.type`.
export const CapabilityTypeSchema = z.enum(["mcp", "code", "skill", "environment", "delegation"]);
export type CapabilityType = z.infer<typeof CapabilityTypeSchema>;

// The reserved OWNER workspace for FIRST-PARTY (Everdict-authored) capabilities — the default-toolset tier. Mirrors
// the registry's `_shared` fallback: these are readable by every workspace and (the ones shipped as defaults) are
// included in an agent's toolset WITHOUT an explicit adoption, subject to an integration gate + the workspace's
// opt-outs. A workspace can still shadow one by adopting a same-named capability. See
// docs/architecture/capability-store.md ("First-party default toolset").
export const FIRST_PARTY_TENANT = "_everdict";

// A configured integration a first-party default capability depends on. The default is active only when the workspace
// has that integration configured (Mattermost set / GitHub App installed / an image registry registered). A generic
// default (web search / PDF) declares no requirement (`null` at the default site) and is unconditional.
export const CapabilityRequirementSchema = z.enum(["mattermost", "github", "image-registry"]);
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>;

// A secret the ADOPTER must supply when they adopt this capability — declared by NAME + description only, never a
// value (the adopter maps each name to one of their own workspace SecretStore keys at adoption). Same discipline as
// AgentMcpServer.authSecret / ModelSpec.apiKeySecret.
export const RequiredSecretSchema = z
  .object({
    name: z.string().min(1), // the logical name the capability references (e.g. "API_KEY")
    description: z.string().default(""), // what it is / where to get it (shown at adoption)
  })
  .strict();
export type RequiredSecret = z.infer<typeof RequiredSecretSchema>;

// --- the discriminated spec: a capability is exactly one of three kinds ---

// mcp — a curated, managed MCP connection (the "adapter"): the store entry already knows how to reach the server,
// which secrets the adopter must supply, and what tools it provides, so a member adopts it instead of hand-wiring one.
// TWO transports: a remote Streamable-HTTP server (`url`) OR a containerized stdio server (`image`, run as
// `docker run --rm -i <image> [args]` — isolation by construction, enabled per operator opt-in). EXACTLY ONE of
// {url, image} — enforced at the input boundary (SaveCapabilityBodySchema.superRefine), NOT here, because a
// discriminatedUnion member may not be a refined ZodEffects (zod v3); the runtime prefers image, else url, else skips.
// requiredSecrets bind to the `Authorization` header (url) or to container env vars (image); the adopter maps each
// name to one of their own secrets at adoption.
// The effect contract (trust-kernel O4): what invoking this capability DOES to the world outside the
// sandbox. "deploy" as one opaque verb is how an agent inherits a footgun — a WRITE-capable capability must
// say its blast radius, whether a retry is safe, how one invocation is undone, and what a partial success
// leaves behind. The domain guard (assertCapabilityEffects) refuses registering a write-capable capability
// without it: an undeclared side effect is not a smaller side effect.
// How one invocation is undone. Prose was the v1 shape and still parses (wire compatibility — every stored
// contract keeps working), but prose is only ever read by a human, and the invocation-time gate needs to
// ACT on the answer. The tagged forms say the three things that actually differ:
//   capability   — another capability undoes it, named. The one machine-actionable answer.
//   compensation — a described procedure, not a single call. Honest about needing judgment.
//   irreversible — it cannot be undone. `requiresApproval: true` is tautological by type, and that is the
//                  point: an author declaring irreversibility must WRITE the consent requirement down, and
//                  the gate reads it rather than inferring it from a verb in the tool's name.
export const RollbackPlanSchema = z.union([
  z.string().min(1).max(500),
  z.object({ kind: z.literal("capability"), capability: z.string().min(1) }),
  z.object({ kind: z.literal("compensation"), description: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("irreversible"), requiresApproval: z.literal(true) }),
]);
export type RollbackPlan = z.infer<typeof RollbackPlanSchema>;

// Where the data goes — the axis `sideEffect` cannot express. A read tool has no side effect and can still be
// the most sensitive thing an agent holds: reading the workspace and reaching an outside network are the two
// halves of exfiltration, and "sideEffect: none" says nothing about either. Optional, because an author who
// cannot honestly answer should not be made to guess — an invented declaration is worse than an absent one.
export const DataAccessSchema = z.object({
  reads: z.enum(["none", "workspace", "external"]).optional(), // what it can SEE
  egress: z.enum(["none", "workspace", "external"]).optional(), // where what it saw can GO
});
export type DataAccess = z.infer<typeof DataAccessSchema>;

export const EffectContractSchema = z.object({
  // none: pure computation/read · workspace: mutates everdict-owned state · external: reaches an outside
  // system (deploys, emails, third-party writes) — the highest blast radius.
  sideEffect: z.enum(["none", "workspace", "external"]),
  idempotent: z.boolean().optional(), // calling twice ≡ calling once. Absent = UNKNOWN — treated as NOT idempotent.
  rollback: RollbackPlanSchema.optional(), // how one invocation is undone (see RollbackPlanSchema)
  partialFailure: z.string().min(1).max(500).optional(), // what a partial success leaves behind and how to tell
  dataAccess: DataAccessSchema.optional(), // what it can see and where that can go (see DataAccessSchema)
});
export type EffectContract = z.infer<typeof EffectContractSchema>;

// ── What a DECLARATION means for a consent gate (pure, beside the contract — the isMeasured precedent).
// Lives in contracts because the agent-runtime kernel must consult it on every tool call without a domain
// dependency: readOnly and safe-without-consent are NOT the same claim, and a read tool whose declaration
// says its data can leave the boundary is exfiltration-shaped regardless of having no side effect.
//
// GUARDED means "keep asking a human even in auto mode". Four independent reasons, any one sufficient:
export function effectsRequireConsent(effects: EffectContract): boolean {
  // ① It leaves the boundary. An external effect is the one everdict cannot undo on the caller's behalf.
  if (effects.sideEffect === "external") return true;
  // ② A retry is not free. Absent idempotency is UNKNOWN, and unknown is not a smaller risk — a mutation
  //    nobody promised was safe to repeat gets the same treatment as one declared unsafe.
  if (effects.sideEffect === "workspace" && effects.idempotent !== true) return true;
  // ③ The author said it cannot be undone, and wrote the consent requirement down. Reading that is the
  //    entire reason the tagged form exists.
  if (typeof effects.rollback === "object" && effects.rollback.kind === "irreversible") return true;
  // ④ Data leaves the boundary. Orthogonal to sideEffect on purpose: a READ tool that can reach an outside
  //    network is exfiltration-shaped, and "sideEffect: none" is a true statement about the wrong axis.
  if (effects.dataAccess?.egress === "external") return true;
  return false;
}

export const McpToolSpecSchema = z.object({
  type: z.literal("mcp"),
  url: z.string().url().optional(), // remote MCP endpoint (Streamable HTTP) — auth = requiredSecrets[0] → Authorization header
  image: z.string().min(1).optional(), // container image → `docker run --rm -i <image> [args]` (MCP over stdio); requiredSecrets → --env
  args: z.array(z.string()).default([]), // trailing args appended after the image (stdio transport only; ignored for url)
  provides: z.array(z.string()).default([]), // the tool names this server exposes (store card / discovery only)
  requiredSecrets: z.array(RequiredSecretSchema).default([]), // secrets the adopter supplies at adoption (header value for url; env vars for image)
  write: z.boolean().default(false), // does this server offer mutating tools (adopter still opts in per-adoption)
  effects: EffectContractSchema.optional(), // REQUIRED (domain guard) when write=true — see EffectContractSchema
});
export type McpToolSpec = z.infer<typeof McpToolSpecSchema>;

// code — a python/node function Everdict runs (the script-grader execution contract: serialized context JSON as
// argv[1], a ToolResult-shaped JSON on stdout) and bridges as a callable tool. The source is pinned by the immutable
// version, so an adopter can audit exactly what they run; adopted-from-others code runs sandboxed (see the docs).
// A worked example for a code tool — a concrete input (the tool's argument object) with an optional label/note.
// Triple duty: store detail shows it (a browsing member sees what the tool DOES, not just its source), the store's
// try-runner executes it (verify before adopting), and the agent bridge appends it to the tool description (the
// model learns the call shape from a real invocation, not just the JSON Schema).
export const CodeToolExampleSchema = z.object({
  name: z.string().min(1).max(60).optional(), // short label (e.g. "basic search")
  input: z.record(z.unknown()).default({}), // the tool-call arguments this example runs with
  note: z.string().max(300).optional(), // what this example demonstrates / what to expect
});
export type CodeToolExample = z.infer<typeof CodeToolExampleSchema>;

export const CodeToolSpecSchema = z.object({
  type: z.literal("code"),
  language: z.enum(["python", "node"]),
  code: z.string().min(1), // the source
  parametersSchema: z.record(z.unknown()).default({}), // JSON Schema for the tool's arguments (shown to the model verbatim)
  isReadOnly: z.boolean().default(true), // read-only tools skip the permission gate; writes require consent
  requiredSecrets: z.array(RequiredSecretSchema).default([]), // env the adopter binds at adoption
  timeoutSec: z.number().int().positive().optional(),
  image: z.string().optional(), // optional dedicated sandbox image (else the default hardened sandbox)
  examples: z.array(CodeToolExampleSchema).max(8).default([]), // worked examples (store detail · try-runner · tool description)
  effects: EffectContractSchema.optional(), // REQUIRED (domain guard) when isReadOnly=false — see EffectContractSchema
});
export type CodeToolSpec = z.infer<typeof CodeToolSpecSchema>;

// skill — instructions + optional supporting files (Claude-Code-style progressive disclosure: the SKILL.md body loads
// via use_skill, each reference file via read_skill_file). The versioned, shareable successor to SkillRecord.
export const SkillCapabilitySpecSchema = z.object({
  type: z.literal("skill"),
  instructions: z.string(), // the SKILL.md body, loaded on demand when the agent invokes the skill
  files: SkillFilesSchema.default([]), // supporting reference files, each loaded individually on demand
});
export type SkillCapabilitySpec = z.infer<typeof SkillCapabilitySpecSchema>;

// environment — a managed eval-environment IMAGE as a store asset: a versioned image reference plus the "wiring
// dowry" (preset) and prose (instructions) that let a member — or a topology-composing agent — consume the
// environment without re-discovering how it is put together. Unlike the tool kinds it is consumed at harness
// AUTHORING time (template pins / services[].image / command image), never bridged as a runtime tool. Pull auth is a
// per-consumer registry concern (WorkspaceSettings.imageRegistries), so no requiredSecrets on the asset.
// SSOT: docs/architecture/environment-image-store.md.

// What's inside the image — discovery metadata for the store card (a headline, not a manifest).
export const EnvironmentContentsSchema = z
  .object({
    benchmark: z.string().optional(), // the benchmark this environment serves (e.g. "officeqa")
    packages: z.array(z.string()).default([]), // headline libraries/tools baked in
    os: z.string().optional(), // "linux" | "windows" | … — informs placement expectations
    arch: z.string().optional(), // "amd64" | "arm64" | …
  })
  .strict();
export type EnvironmentContents = z.infer<typeof EnvironmentContentsSchema>;

// The wiring dowry: how a topology composes around THIS image. Every field is a suggestion consumed at AUTHORING
// time (form prefill / agent context) — never silently applied at dispatch. Reuses the topology vocabulary verbatim
// so a preset fragment is copy-paste-valid in a HarnessSpec (the inject-template vocabulary etc. validate for free).
export const EnvironmentPresetSchema = z
  .object({
    // Suggested service fragment for running this image as a topology service: port, env defaults, readiness,
    // resources, wiring, needs. No image (it IS this asset) and no name (the adopting template names the service) —
    // strict, so an accidental image/name key is REJECTED, not silently stripped.
    service: TopologyServiceSchema.omit({ image: true, name: true }).partial().strict().optional(),
    // Stores this environment expects (postgres/redis/minio + isolateBy + inject templates).
    dependencies: z.array(TopologyDependencySchema).default([]),
    // Present when the image is a front-door service (how to submit/complete against it).
    frontDoor: FrontDoorSpecSchema.optional(),
    // Present when the environment expects a browser/OS target.
    target: TopologyTargetSchema.optional(),
  })
  .strict();
export type EnvironmentPreset = z.infer<typeof EnvironmentPresetSchema>;

export const EnvironmentImageSpecSchema = z.object({
  type: z.literal("environment"),
  image: z.string().min(1), // fully-qualified pullable ref; digest-pinned recommended (mutable tag → publish warning)
  contents: EnvironmentContentsSchema.optional(),
  preset: EnvironmentPresetSchema.optional(),
  // Markdown: how the environment is composed — entry points, conventions, seeded data, gotchas. This is the context
  // a topology-composing agent receives; written for a reader who will wire the image into a harness.
  instructions: z.string(),
});
export type EnvironmentImageSpec = z.infer<typeof EnvironmentImageSpecSchema>;

// delegation — a WORK ENVIRONMENT everdict can hand work TO: which conversational agent runs, in which
// prebuilt image, against which model, with which env/secrets, under which standing instructions. Registered
// once, referenced thereafter — the alternative is every delegation re-specifying an image ref, hoping the
// workspace secret tiers happen to hold the right names, and getting no model binding at all (a process
// harness spec is `{kind,id,version}` and carries none of it).
//
// The delegate is EMPLOYED, not under test — which is why this is a capability and not a harness: a workspace
// adopts it, shares it, versions it and picks it from the store, exactly like the tools and skills it already
// keeps there. The profile never re-implements the agent; it pins the environment the agent runs in, so any
// adapter carrying the `conversational` marker qualifies.
export const DelegationProfileSpecSchema = z.object({
  type: z.literal("delegation"),
  // WHICH conversational agent runs (a built-in id like claude-code, or a registered harness).
  harness: z.object({ id: z.string().min(1), version: z.string().optional() }),
  // The prebuilt image the agent runs in — its CLI already installed, so a delegation costs no per-session
  // install. Fully-qualified + pullable; digest-pinned recommended, like an environment asset.
  image: z.string().min(1),
  // A registered Model → baseUrl + underlying model + the key from its apiKeySecret, injected as env (the
  // same resolution the eval lane does, billing attribution included). ModelRef.env remaps the var NAMES for
  // a CLI that expects different ones.
  model: ModelBindingSchema.optional(),
  // Free-form environment: a literal, or {secretRef, scope} resolved from the workspace/personal tiers at
  // boot. Values never live on the record.
  env: z.record(z.string(), EnvValueSchema).default({}),
  // The conversation's stable working directory (default "work"). Stable because a resuming agent keys its
  // session store off the cwd — see docs/architecture/harness-playground.md §Conversations.
  workDir: z.string().optional(),
  // The STANDING brief — what this environment is, its conventions and its gotchas — seeded into the sandbox
  // as a file the agent reads by convention. The per-delegation brief (goal/references/constraints) is
  // separate and arrives per call; this is what is true of every delegation into this profile.
  instructions: z.string(),
  // The convention file THIS agent reads on start (CLAUDE.md · AGENTS.md · …). One string, so the profile
  // generalizes past any single CLI's convention.
  instructionsFile: z.string().min(1).default("CLAUDE.md"),
  ttlSec: z.number().int().positive().optional(), // the delegation's default session budget
});
export type DelegationProfileSpec = z.infer<typeof DelegationProfileSpecSchema>;

export const CapabilitySpecSchema = z.discriminatedUnion("type", [
  McpToolSpecSchema,
  CodeToolSpecSchema,
  SkillCapabilitySpecSchema,
  EnvironmentImageSpecSchema,
  DelegationProfileSpecSchema,
]);
export type CapabilitySpec = z.infer<typeof CapabilitySpecSchema>;

// A published, versioned capability in the Store. `(tenant, id, version)` is immutable like every registry entity;
// `visibility`/`sharedWith`/`tags` are MUTABLE capability-level metadata (outside spec-content immutability, on par
// with version tags — promoting reach never rewrites content). No `updatedAt` — editing content = a new version.
export const CapabilityRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(), // the OWNER workspace (the publisher)
  version: z.string(), // immutable; new content = new version (semver / registration order, like harness/judge)
  name: z.string(), // the tool/skill name the agent sees (namespaced at runtime)
  description: z.string(), // the discovery line (store card + the model's when-to-use)
  spec: CapabilitySpecSchema,
  visibility: CapabilityVisibilitySchema,
  sharedWith: z.array(z.string()).default([]), // target workspace ids (⊆ the AUTHOR's memberships); only when visibility === 'subset'
  tags: z.array(z.string()).default([]),
  createdBy: z.string(), // subject; owner
  createdAt: z.string(),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecordSchema>;

// An adopted capability inside an AgentSpec — an immutable-version REFERENCE into the Store (npm-style pin) plus the
// consumer-side binding layered at adoption. The runtime resolves it (cross-tenant, re-checking visibility, best-effort)
// so an eval run stays reproducible. The `source` is the OWNER workspace (= the consumer's own tenant for private/workspace).
export const CapabilityRefSchema = z
  .object({
    source: z.string(), // the OWNER workspace that published it (= my tenant for private/workspace)
    id: z.string(),
    version: z.string(), // the pinned immutable version (reproducible)
    secretBindings: z.record(z.string()).default({}), // requiredSecrets[].name → one of MY workspace's secret names
    enableWrite: z.boolean().default(false), // opt in to a write-capable mcp/code capability
  })
  .strict();
export type CapabilityRef = z.infer<typeof CapabilityRefSchema>;
