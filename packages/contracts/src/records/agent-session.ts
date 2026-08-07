import { z } from "zod";
import { EventSelectorFilterSchema } from "./event-selector.js";

// A conversation parked on the world. When an agent calls `wait_for`, its turn ends with stopReason "waiting" —
// deliberately NOT "end_turn": the work is unfinished and the ball is still the AGENT's, not the member's. The
// intent left behind is what makes that promise keepable: it lives on the session record, so a matching platform
// event (or the deadline) resumes THIS conversation, and an agent-service restart re-arms the watch instead of
// silently dropping it. Cleared the moment the session is resumed.
export const AgentWakeIntentSchema = z
  .object({
    // Event kinds that should resume the conversation. Membership in TRIGGERABLE_EVENT_KINDS is enforced at the
    // tool boundary; stored loosely so an intent written by an older build still parses. EMPTY = a pure timer
    // wait (LESSON 059 P6, the Sleep reinterpretation): no event can match an empty allowlist, so only the
    // deadline wakes the conversation — self-paced "check again in N minutes" without polling.
    kinds: z.array(z.string().min(1)),
    // Payload predicates (shared selector grammar) — "this scorecard", not "any scorecard".
    filters: z.array(EventSelectorFilterSchema).default([]),
    // What the agent is waiting for, in its own words. Replayed into the resumed turn and rendered in the UI, so a
    // waiting conversation reads as a STATE ("watching scorecard sc_123") and never as a dead one.
    note: z.string().min(1),
    // Wake anyway at/after this instant even if nothing lands — the guard against silence. A batch that dies
    // without emitting a terminal fact must not strand its watcher forever.
    deadlineAt: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type AgentWakeIntent = z.infer<typeof AgentWakeIntentSchema>;

// How a conversation's mutating tool calls are approved — the member's standing choice for the session (a per-turn
// body.mode still overrides). default = ask for every mutation (HITL) · auto = auto-allow routine mutations, ask only
// for guarded (destructive / governance / credential) actions · bypass = never ask · plan = read-only until the
// agent's plan is approved. Coarse control-plane RBAC bounds every call regardless of mode.
export const AGENT_PERMISSION_MODES = ["default", "auto", "bypass", "plan"] as const;
export const AgentPermissionModeSchema = z.enum(AGENT_PERMISSION_MODES);
export type AgentPermissionMode = z.infer<typeof AgentPermissionModeSchema>;

// What started a session — chat (a member typed), discussion (@everdict in a comment thread), teammate (a
// spawned standing agent), trigger (a platform event matched a crafted agent's trigger — agent-automation A3),
// schedule, or api. Trigger runs pin the crafted agent's id@version + the waking event, which is ALSO the
// durable activation dedup key (one run per (agent, event), at-least-once delivery collapses here).
export const AGENT_SESSION_ORIGIN_TYPES = ["chat", "discussion", "teammate", "trigger", "schedule", "api"] as const;
export const AgentSessionOriginSchema = z.object({
  type: z.enum(AGENT_SESSION_ORIGIN_TYPES),
  agentId: z.string().optional(),
  agentVersion: z.string().optional(),
  eventId: z.string().optional(),
  eventKind: z.string().optional(),
});
export type AgentSessionOrigin = z.infer<typeof AgentSessionOriginSchema>;

// A headless run's lifecycle (the observability anchor — agent-automation A4). Chat sessions have no status
// (a conversation is not a run); the agent service's activation wrapper owns the transitions.
export const AGENT_RUN_STATUSES = ["running", "awaiting_approval", "completed", "failed", "cancelled"] as const;
export const AgentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

// A conversation between a workspace member and Everdict's own agent. Personal to its owner (the creator's
// subject) but workspace-scoped for data access — the agent reads that workspace's eval data on the owner's
// behalf. See docs/architecture/agent-conversations.md.
// A standing TEAMMATE's durable config (LESSON 059 P2) — see the `teammate` field below for the why.
export const AgentTeammateConfigSchema = z
  .object({
    name: z.string().min(1),
    task: z.string().min(1),
    watch: z.array(z.string()).default([]),
    keyId: z.string().min(1),
  })
  .strict();
export type AgentTeammateConfig = z.infer<typeof AgentTeammateConfigSchema>;

export const AgentSessionRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  owner: z.string(), // creator subject — sessions are listed per-owner (a member's own chat history)
  title: z.string(),
  // Registered model id this conversation runs on (a per-conversation override the member picks in the chat).
  // Unset → the workspace AgentSpec's model (Settings › Agent) → the agent server's default model.
  model: z.string().optional(),
  // The session's standing permission mode (the member picks it in the chat header). Unset → "default" (ask).
  permissionMode: AgentPermissionModeSchema.optional(),
  // Session running memory (Claude Code's session memory reinterpreted): a rolling digest of the conversation's
  // OLDEST records, maintained at turn boundaries once the replayed transcript outgrows the budget. The next turn
  // replays `memory` (as a leading synthetic user turn) + only the records with seq > memoryThroughSeq — bounded
  // replay, so a long conversation stops re-reading (and re-compacting) its entire past every turn. Unset → full
  // replay (the historical behaviour). The digest is model text, never member-authored — display surfaces skip it.
  memory: z.string().optional(),
  memoryThroughSeq: z.number().int().nonnegative().optional(),
  // Who may read/continue the conversation: unset|"private" = the owner only (personal chat history);
  // "workspace" = any workspace member (e.g. a comment-thread discussion session — the shared detail surface).
  visibility: z.enum(["private", "workspace"]).optional(),
  // What started this session (unset = legacy/chat). Trigger runs carry agentId@version + the waking event.
  origin: AgentSessionOriginSchema.optional(),
  // The LATEST ledger run for this session (execution-model P3 — an activation/turn = a Run{kind:"agent"};
  // the session is the run's group). Unset on chat sessions and pre-P3 records.
  runId: z.string().optional(),
  // Headless-run lifecycle status (unset for plain conversations). See AgentRunStatusSchema.
  status: AgentRunStatusSchema.optional(),
  // Set while this conversation is WAITING on the world (the agent called wait_for). Present = the agent still
  // owes the member an answer; absent = nothing is being watched. See AgentWakeIntentSchema.
  wakeIntent: AgentWakeIntentSchema.optional(),
  // A standing TEAMMATE's durable config (LESSON 059 P2): everything the agent service needs to re-register
  // the teammate after a restart — the roster used to live only in a process Map, so one restart evaporated
  // the whole team (name, watch kinds, standing token) with nothing to rebuild it from. The execution token
  // itself is NEVER stored (tenant keys are hashed one-way); a boot restore mints a fresh one and revokes the
  // stale key by `keyId`. Present = this session IS a live teammate; cleared when the teammate is dismissed.
  teammate: AgentTeammateConfigSchema.optional(),
  // Fine-grained standing permission rules for THIS conversation (LESSON 059 P4): tool name → allow|deny,
  // consulted before the human ask (the "always allow/deny this tool here" layer above modes). Persisted so a
  // service restart does not silently reopen every prompt the member already answered with "always".
  permissionRules: z.record(z.enum(["allow", "deny"])).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentSessionRecord = z.infer<typeof AgentSessionRecordSchema>;

// One assistant tool request, stored so the transcript can be replayed into the model as loop history. `arguments`
// is the raw JSON string the model produced (kept verbatim to reconstruct the OpenAI tool_call).
export const AgentToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
});
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;

// The workspace entity kinds a message can @-reference. Each maps to a control-plane read (get_<kind>) the agent
// resolves into context, and to a list endpoint the composer's mention picker browses. `trace` is the exception: it is
// keyed by (source, id=traceId) not (id, version), resolves via inspect_trace, and is attached from the observability
// browser (a "mention in chat" button), not the @-picker — cross-source browsing there would be prohibitively wide.
// `environment` is an environment-kind capability (get_capability): the eval image asset, so "wire this environment
// into a harness" / "fix its instructions" can be handed to the agent the same way every other entity is. `tool` is
// its tool-kind sibling (mcp | code — also get_capability), so "make this tool do X" from Settings › Agent › Tools
// reaches the agent with the tool's own spec already in context.
// `knowledge` is a reified claim (get_knowledge_entry) — what the workspace has LEARNED, not what it is configured
// with; the injected record carries its lineage fields (`supersedes`, `verifiedAt`, coverage), so "what does this
// claim say" and "how did it get here" are both answerable from the reference.
export const AGENT_REFERENCE_TYPES = [
  "harness",
  "runtime",
  "run",
  "dataset",
  "scorecard",
  "judge",
  "view",
  "skill",
  "knowledge",
  "environment",
  "tool",
  "trace",
  // The eval tracker's issue (docs/tracker.md) — the "why" behind a run: what problem is under evaluation,
  // which scorecard closed it, and whether it has regressed since. The context an agent needs before it
  // re-investigates something the team already resolved.
  "issue",
] as const;
export const AgentReferenceTypeSchema = z.enum(AGENT_REFERENCE_TYPES);
export type AgentReferenceType = z.infer<typeof AgentReferenceTypeSchema>;

// An @-mention on a user turn — the entity whose context the agent is handed. label is the display text the
// composer showed (denormalized so the transcript renders the chip without re-fetching). `source` is set ONLY for a
// `trace` reference: the registered trace-source name the trace lives in (the agent inspects it as (source, id)).
export const AgentReferenceSchema = z.object({
  type: AgentReferenceTypeSchema,
  id: z.string(),
  version: z.string().optional(),
  label: z.string(),
  source: z.string().optional(),
});
export type AgentReference = z.infer<typeof AgentReferenceSchema>;

// A file the user attached to a turn — metadata only (name/type/size). The text content is folded into the model
// context at send time (like an @-reference) but is NOT persisted; the transcript shows a chip by name.
export const AgentAttachmentSchema = z.object({
  name: z.string(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});
export type AgentAttachment = z.infer<typeof AgentAttachmentSchema>;

// One transcript message. `role` mirrors the chat protocol: a `user` turn, an `assistant` reply (text and/or
// tool_calls), or a `tool` result answering an assistant tool_call. `seq` orders the transcript within a session.
export const AgentMessageRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
  // assistant turns: the model's reasoning / extended-thinking text for this turn (display text only — the native
  // thinking blocks used for same-turn tool-use replay are held in memory by the loop, never persisted). Absent when
  // the model produced no reasoning (non-reasoning model / thinking disabled).
  reasoning: z.string().optional(),
  toolCalls: z.array(AgentToolCallSchema).optional(), // assistant turns that requested tools
  toolCallId: z.string().optional(), // tool turns: the assistant tool_call this answers
  name: z.string().optional(), // tool turns: the tool name (for display)
  references: z.array(AgentReferenceSchema).optional(), // user turns: the entities @-referenced this turn
  attachments: z.array(AgentAttachmentSchema).optional(), // user turns: files attached (metadata only)
  createdAt: z.string(),
});
export type AgentMessageRecord = z.infer<typeof AgentMessageRecordSchema>;
