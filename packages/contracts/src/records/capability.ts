import { z } from "zod";

// Capability Store contracts — one discriminated `Capability` entity (kind ∈ mcp|code|skill) that a workspace's
// members AUTHOR and PUBLISH at one of four reach tiers, and that a browsing member ADOPTS into their agent by an
// immutable-version reference. Mirrors the Judge model|harness|code idiom (one entity, one `type` discriminant).
// SSOT: docs/architecture/capability-store.md.

// A capability's reach tier. Extends the private|workspace vocabulary (Views / skills / browser-profiles) with the
// two cross-tenant tiers. `subset` fans a capability across the AUTHOR's OWN workspaces (a chosen subset of the
// workspaces they are a member of — "this skill, in 2 of my 5 workspaces"), NOT a publish to strangers; `public` is
// the real expose-to-everyone tier (admin-gated). workspace = tenant = trust-zone.
export const CapabilityVisibilitySchema = z.enum(["private", "workspace", "subset", "public"]);
export type CapabilityVisibility = z.infer<typeof CapabilityVisibilitySchema>;

// The kind discriminant (also stored as an indexed column for browse-by-type). Derived from `spec.type`.
export const CapabilityTypeSchema = z.enum(["mcp", "code", "skill"]);
export type CapabilityType = z.infer<typeof CapabilityTypeSchema>;

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

export const CapabilitySpecSchema = z.discriminatedUnion("type", [
  McpToolSpecSchema,
  CodeToolSpecSchema,
  SkillCapabilitySpecSchema,
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
