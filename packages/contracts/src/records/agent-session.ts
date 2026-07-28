import { z } from "zod";

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
  // Who may read/continue the conversation: unset|"private" = the owner only (personal chat history);
  // "workspace" = any workspace member (e.g. a comment-thread discussion session — the shared detail surface).
  visibility: z.enum(["private", "workspace"]).optional(),
  // What started this session (unset = legacy/chat). Trigger runs carry agentId@version + the waking event.
  origin: AgentSessionOriginSchema.optional(),
  // Headless-run lifecycle status (unset for plain conversations). See AgentRunStatusSchema.
  status: AgentRunStatusSchema.optional(),
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
export const AGENT_REFERENCE_TYPES = [
  "harness",
  "runtime",
  "run",
  "dataset",
  "scorecard",
  "judge",
  "view",
  "skill",
  "trace",
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
