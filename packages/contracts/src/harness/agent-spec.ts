import { z } from "zod";
import { VersionSchema } from "../version.js";

import { CapabilityRefSchema } from "../records/capability.js";

// A workspace-registered MCP tool server the Everdict agent connects to IN ADDITION to the built-in read-only
// control-plane tools. The workspace owns this server, so — unlike the built-in tools, which stay read-only — its
// tools MAY mutate: `write` is an explicit per-server opt-in and the workspace is responsible for what its own server
// does. ⚠️ NO plaintext secret here — authSecret names a workspace SecretStore key; the VALUE is resolved just before
// the agent connects and sent verbatim as the `Authorization` header (same discipline as ModelSpec.apiKeySecret /
// runtime authSecret).
export const AgentMcpServerSchema = z
  .object({
    name: z.string().min(1), // stable label (shown in tool activity; unique within one agent)
    url: z.string().url(), // MCP endpoint (Streamable HTTP)
    authSecret: z.string().optional(), // NAME of a workspace SecretStore key → sent as `Authorization: <value>` (value is verbatim, e.g. "Bearer …")
    write: z.boolean().default(false), // opt-in: false → only read-verb tools bridged; true → all of this server's tools (writes allowed)
  })
  .strict();
export type AgentMcpServer = z.infer<typeof AgentMcpServerSchema>;

// Agent — a workspace-registered configuration of the Everdict conversational agent ("how THIS workspace's agent
// behaves"). It plugs workspace-specific augmentation into the already-built shared agent framework, the way Claude
// Code takes a per-project CLAUDE.md (context) + MCP servers (tools): `instructions` extend the base system prompt,
// `mcpServers` add tools beyond the built-in read-only control-plane surface, `model` picks which registered model
// powers it. Registration / versioning / tenant-ownership follow the SAME immutable-version SSOT as harness/judge/model
// (owner-first + `_shared` fallback, immutable versions, soft-delete tombstones). Skills are a later channel (Phase 2).
// ⚠️ NO secrets in the spec — `model` is a registered-model id, each `mcpServers[].authSecret` is a secret NAME.
export const AgentSpecSchema = z.object({
  id: z.string(),
  version: VersionSchema,
  description: z.string().optional(),
  // Workspace context appended to the agent's base system prompt (its persona + tool protocol stay fixed). CLAUDE.md-like.
  instructions: z.string().optional(),
  // Workspace MCP tool servers connected alongside the built-in read-only tools (write opt-in per server). This is
  // the RAW escape hatch — a server hand-wired without publishing it to the Capability Store (mirrors openai-compatible
  // as the LLM escape hatch). The curated path is `capabilities` below.
  mcpServers: z.array(AgentMcpServerSchema).default([]),
  // Capabilities adopted from the Store — immutable-version references (npm-style pins) into the Capability catalog
  // (mcp | code | skill). Resolved at runtime (cross-tenant, visibility re-checked). See docs/architecture/capability-store.md.
  capabilities: z.array(CapabilityRefSchema).default([]),
  // Registered model id (this workspace's model registry) powering the agent; unset → the agent server's default model.
  model: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;
