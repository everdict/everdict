import { z } from "zod";
import { VersionSchema } from "../version.js";

import { AgentPermissionModeSchema } from "../records/agent-session.js";
import { CapabilityRefSchema } from "../records/capability.js";
import type { PlatformEventKind } from "../records/platform-event.js";

// A workspace-registered MCP tool server the Everdict agent connects to IN ADDITION to the built-in read-only
// control-plane tools. The workspace owns this server, so — unlike the built-in tools, which stay read-only — its
// tools MAY mutate: `write` is an explicit per-server opt-in and the workspace is responsible for what its own server
// does. ⚠️ NO plaintext secret here — authSecret names a workspace SecretStore key; the VALUE is resolved just before
// the agent connects and sent verbatim as the `Authorization` header (same discipline as ModelSpec.apiKeySecret /
// runtime authSecret).
// The platform-event kinds an agent trigger may subscribe to — the platform vocabulary MINUS the agent-run
// lifecycle facts (v1 guardrail: agents watching agents is a runaway vector; see agent-automation.md).
export const TRIGGERABLE_EVENT_KINDS = [
  "run.submitted",
  "run.completed",
  "run.failed",
  "scorecard.submitted",
  "scorecard.case.completed",
  "scorecard.completed",
  "scorecard.failed",
  "scorecard.cancelled",
  "report.completed",
  "comment.created",
  // E2 coverage (event-plumbing.md §3): content/registry, fs, knowledge, and ops facts are automation
  // hooks ("new dataset version → run the baseline", "watch this folder", "review proposed knowledge",
  // "an agent hit its budget"). Loop safety holds: agent-caused publishes carry causedBy agent:<id>:<conv>
  // (loop guard #1), activation cooldowns bound re-fires, and budget.exceeded creates no run by definition.
  "harness.registered",
  "dataset.registered",
  "judge.registered",
  "file.published",
  "knowledge.created",
  "knowledge.proposed",
  "knowledge.approved",
  "budget.exceeded",
  // E3 time events: a time-driven agent = a subscription on the clock's tick (bounded by the schedule's
  // own cadence + the activation cooldown).
  "schedule.fired",
  // E4: the flagship loop's wake signal — a production trace crossing a tenant threshold wakes the triage
  // agent (bounded by the activation cooldown; the woken run is enveloped like any other).
  "trace.threshold_crossed",
  "trace.ingestion_throttled",
  // Task ledger (agent-teams): "new work appeared" / "a dependency cleared" — the team wake-up pair. The
  // creator never wakes on its own task (causedBy loop guard); cross-agent wakes are the ledger's purpose.
  "task.created",
  "task.completed",
] as const;
// Compile-time subset guarantee: every triggerable kind is a real platform-event kind.
const _triggerableAreKinds: readonly PlatformEventKind[] = TRIGGERABLE_EVENT_KINDS;
void _triggerableAreKinds;

// One declarative payload predicate — filters AND together against the event's pointer payload
// (e.g. { field: "passRate", op: "lt", value: 1 } = "the batch had failing cases").
export const AgentTriggerFilterSchema = z
  .object({
    field: z.string().min(1),
    op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "exists"]),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(), // required for every op except "exists"
  })
  .strict();
export type AgentTriggerFilter = z.infer<typeof AgentTriggerFilterSchema>;

// A trigger — the declarative subscription that lets a platform event activate this agent headlessly
// (docs/architecture/agent-automation.md A3). Matching + activation live in the agent service.
export const AgentTriggerSchema = z
  .object({
    kinds: z.array(z.enum(TRIGGERABLE_EVENT_KINDS)).min(1),
    filters: z.array(AgentTriggerFilterSchema).default([]),
  })
  .strict();
export type AgentTrigger = z.infer<typeof AgentTriggerSchema>;

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
  // First-party DEFAULT capabilities this workspace has turned OFF (capability ids owned by the FIRST_PARTY_TENANT).
  // Defaults (web search, PDF, integration tools) are included in the agent's toolset without adoption; listing an id
  // here opts that one default out. Adopting a same-named capability also shadows a default. See capability.ts.
  disabledDefaults: z.array(z.string()).default([]),
  // Registered model id (this workspace's model registry) powering the agent; unset → the agent server's default model.
  model: z.string().optional(),
  // Standing instructions rendered as the FIRST message of a triggered activation ("when you are woken, do
  // this") — distinct from `instructions`, which shape every turn of every conversation. Unset → the rendered
  // event alone seeds the run.
  task: z.string().optional(),
  // Declarative platform-event subscriptions (agent-automation A3). Non-empty + enabled → the agent service
  // activates a headless run per matching event.
  triggers: z.array(AgentTriggerSchema).default([]),
  // Default permission mode for this agent's headless runs (default = ask → parked approvals; auto/bypass for
  // trusted automation). A chat session's own mode still overrides per conversation.
  permissionMode: AgentPermissionModeSchema.optional(),
  // Per-ACTIVATION delegated budget (USD) — A7's unenforced per-agent budget becomes the run's ENVELOPE
  // (execution-model §5.2): every run this activation causes draws from this slice and is refused at 402
  // past it. Unset = no envelope (the tenant budget still gates globally). The agent never reasons about
  // capacity — compute-blind demand, budget-bound spend.
  budgetUsd: z.number().positive().optional(),
  // Activation opt-in: only an enabled agent is trigger-matched. The chat "default" config never needs this.
  enabled: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;
