import { z } from "zod";
import {
  FrontDoorSpecSchema,
  TopologyDependencySchema,
  TopologyServiceSchema,
  TopologyTargetSchema,
} from "../harness/harness-spec.js";

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
export const CapabilityTypeSchema = z.enum(["mcp", "code", "skill", "environment"]);
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

// mcp — a curated, managed MCP connection (the "adapter"): the store entry already knows the endpoint, which secrets
// the adopter must supply, and what tools it provides, so a member adopts it instead of hand-typing a server URL.
export const McpToolSpecSchema = z.object({
  type: z.literal("mcp"),
  url: z.string().url(), // MCP endpoint (Streamable HTTP)
  provides: z.array(z.string()).default([]), // the tool names this server exposes (store card / discovery only)
  requiredSecrets: z.array(RequiredSecretSchema).default([]), // secrets the adopter supplies at adoption
  write: z.boolean().default(false), // does this server offer mutating tools (adopter still opts in per-adoption)
});
export type McpToolSpec = z.infer<typeof McpToolSpecSchema>;

// code — a python/node function Everdict runs (the script-grader execution contract: serialized context JSON as
// argv[1], a ToolResult-shaped JSON on stdout) and bridges as a callable tool. The source is pinned by the immutable
// version, so an adopter can audit exactly what they run; adopted-from-others code runs sandboxed (see the docs).
export const CodeToolSpecSchema = z.object({
  type: z.literal("code"),
  language: z.enum(["python", "node"]),
  code: z.string().min(1), // the source
  parametersSchema: z.record(z.unknown()).default({}), // JSON Schema for the tool's arguments (shown to the model verbatim)
  isReadOnly: z.boolean().default(true), // read-only tools skip the permission gate; writes require consent
  requiredSecrets: z.array(RequiredSecretSchema).default([]), // env the adopter binds at adoption
  timeoutSec: z.number().int().positive().optional(),
  image: z.string().optional(), // optional dedicated sandbox image (else the default hardened sandbox)
});
export type CodeToolSpec = z.infer<typeof CodeToolSpecSchema>;

// skill — instructions-only (Claude-Code-style progressive disclosure via the use_skill tool). The versioned,
// shareable successor to SkillRecord.instructions.
export const SkillCapabilitySpecSchema = z.object({
  type: z.literal("skill"),
  instructions: z.string(), // the SKILL.md body, loaded on demand when the agent invokes the skill
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

export const CapabilitySpecSchema = z.discriminatedUnion("type", [
  McpToolSpecSchema,
  CodeToolSpecSchema,
  SkillCapabilitySpecSchema,
  EnvironmentImageSpecSchema,
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
