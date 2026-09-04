import type { AgentSpec as ContractAgentSpec } from '@everdict/contracts'
import type {
  AgentListEntry,
  SaveAgentResult as ContractSaveAgentResult,
} from '@everdict/contracts/wire'
import { z } from 'zod'

import { versionOriginsSchema } from '@/entities/capability-origin'

// Boundary validation for the workspace agent (the conversational assistant) configuration lives only in this zod v4, and the EXPORTED types are pinned to @everdict/contracts (P4).
// `import type` only — the zod v3 wire schemas do not run in the web.

// An MCP tool server the workspace registers — url + authSecret (a secret NAME, never a value) + write (opt-in: on, mutating tools are bridged too).
export const agentMcpServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  authSecret: z.string().optional(),
  write: z.boolean().default(false),
})
export type AgentMcpServer = z.infer<typeof agentMcpServerSchema>

// A capability reference adopted from the store (an immutable version pin). source = the publishing workspace (my own tenant when it is mine); secretBindings = required secret → my secret's name.
export const capabilityRefSchema = z.object({
  source: z.string(),
  id: z.string(),
  version: z.string(),
  secretBindings: z.record(z.string(), z.string()).default({}),
  enableWrite: z.boolean().default(false),
})
export type CapabilityRef = z.infer<typeof capabilityRefSchema>

// The platform event kinds a trigger may subscribe to — the agent.run.* lifecycle facts are EXCLUDED (closing the runaway vector of agents watching agents).
export const TRIGGERABLE_EVENT_KINDS = [
  'run.submitted',
  'run.completed',
  'run.failed',
  'scorecard.submitted',
  'scorecard.case.completed',
  'scorecard.completed',
  'scorecard.failed',
  'scorecard.cancelled',
  'report.completed',
  'comment.created',
  // E2 coverage (event-plumbing.md §3) — content/registry, fs, knowledge, and ops facts are automation hooks too (same vocabulary as the server list).
  'harness.registered',
  'dataset.registered',
  'judge.registered',
  'file.published',
  'knowledge.created',
  'knowledge.proposed',
  'knowledge.approved',
  'budget.exceeded',
  'schedule.fired',
  'trace.threshold_crossed',
  'trace.ingestion_throttled',
  // M2 live anomaly facts — undispatchable, or a runtime circuit opening (the same vocabulary as the server list)
  'run.placement_blocked',
  'runtime.circuit_opened',
  // Task ledger (agent-teams) — "new work appeared" / "a dependency cleared" (same vocabulary as the server list).
  'task.created',
  'task.completed',
  // Eval tracker (docs/tracker.md) — the "why" layer's wake signals: a new issue landed, an issue regressed
  // (payload filter cause eq regression), a project/initiative closed. Same vocabulary as the server list.
  'issue.created',
  'issue.status_changed',
  'project.status_changed',
  'project.update_posted',
  'initiative.status_changed',
  // A goal wobbled — the same payload filter (health eq off_track), on the goal-side update stakeholders read.
  'initiative.update_posted',
  // Product timeline (docs/architecture/product-timeline.md) — a tracked service released / a release was
  // planned / we shipped (payload filter: to eq released). Same vocabulary as the server list.
  'product.service_version_imported',
  'release.created',
  'release.status_changed',
] as const

// One declarative filter over an event payload — filters combine with AND (e.g. passRate < 1 = a batch with a failing case).
export const agentTriggerFilterSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'exists']),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
})
export const agentTriggerSchema = z.object({
  kinds: z.array(z.enum(TRIGGERABLE_EVENT_KINDS)).min(1),
  filters: z.array(agentTriggerFilterSchema).default([]),
})
export type AgentTrigger = z.infer<typeof agentTriggerSchema>

// The session permission mode — the same vocabulary as the agent-session entity (default = confirm every time · auto · bypass · plan).
export const agentSpecPermissionModeSchema = z.enum(['default', 'auto', 'bypass', 'plan'])

// The crafting canvas' draft vocabulary (agent-automation B2/B3) — the subset of AgentSpec a conversation patches through craft_agent.
// It rides on every chat turn as body.agentDraft and comes back over SSE as `agent_draft`.
export const agentDraftSchema = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  task: z.string().optional(),
  triggers: z.array(agentTriggerSchema).optional(),
  permissionMode: agentSpecPermissionModeSchema.optional(),
  model: z.string().optional(),
})
export type AgentDraft = z.infer<typeof agentDraftSchema>

// GET /agents/:id/versions/:version 200 — the whole AgentSpec (instructions + MCP tool servers + adopted capabilities + a model override
// + triggers/standing task/permission mode/activation — agent-automation A3). No secret values.
export const agentSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  mcpServers: z.array(agentMcpServerSchema).default([]),
  capabilities: z.array(capabilityRefSchema).default([]),
  // The first-party default tools this workspace turned OFF (by capability id) — the default toolset (web search, etc.) attaches with no adoption, and the ids listed here are excluded.
  disabledDefaults: z.array(z.string()).default([]),
  // Secret remapping for tools with nowhere of their own to store a binding (a built-in default, an unadopted publication) — tool key → { declared name → the real secret name }.
  // There is never a value here (names only). It MUST be preserved on save (the same rule as capabilities/disabledDefaults).
  toolSecretBindings: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  model: z.string().optional(),
  // The standing instruction rendered as the first message when a trigger activates (distinct from `instructions`, which colours every turn).
  task: z.string().optional(),
  triggers: z.array(agentTriggerSchema).default([]),
  // This agent's default permission mode for headless runs (a chat session's own mode wins per conversation).
  permissionMode: agentSpecPermissionModeSchema.optional(),
  // The activation opt-in — only an enabled agent is a candidate for trigger matching.
  enabled: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
})
export type AgentSpec = z.infer<typeof agentSpecSchema>

// GET /agents/defaults 200 — the built-in (first-party) default tool catalog. A read-only shape for rendering toggles (no contract wire type → no drift guard).
export const agentDefaultSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  requires: z.string().nullish(),
})
export type AgentDefault = z.infer<typeof agentDefaultSchema>
export const agentDefaultsSchema = z.object({ defaults: z.array(agentDefaultSchema) })

// GET /agents 200 — one entry per agent id (workspace-owned plus the _shared fallback).
// `versionOrigins` is the same one line of lineage every other registry list carries — stripped off by the parser, the list cannot draw
// "why does this version exist" (review wave C).
export const agentSummarySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()),
  owner: z.string(),
  createdBy: z.string().optional(),
  versionOrigins: versionOriginsSchema.optional(),
})
export const agentsSchema = z.array(agentSummarySchema)
export type AgentSummary = z.infer<typeof agentSummarySchema>

// PUT /agents/:id 200 — a versionless save (an upsert). created=false means it was identical to the existing latest and no new version was written (idempotent).
export const saveAgentResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  created: z.boolean(),
})
export type SaveAgentResult = z.infer<typeof saveAgentResultSchema>

// The drift guard — the summary is checked in BOTH directions against the wire list entry; the spec and save result are web→contract only (the wire contract is the SSOT).
type AssertAssignable<A extends B, B> = A
type _SummaryFwd = AssertAssignable<AgentSummary, AgentListEntry>
type _SummaryBack = AssertAssignable<AgentListEntry, AgentSummary>
type _SpecFwd = AssertAssignable<AgentSpec, ContractAgentSpec>
type _SaveFwd = AssertAssignable<SaveAgentResult, ContractSaveAgentResult>
type _SaveBack = AssertAssignable<ContractSaveAgentResult, SaveAgentResult>
