import { z } from "zod";

// A conversation between a workspace member and Everdict's own agent. Personal to its owner (the creator's
// subject) but workspace-scoped for data access — the agent reads that workspace's eval data on the owner's
// behalf. See docs/architecture/agent-conversations.md.
export const AgentSessionRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  owner: z.string(), // creator subject — sessions are listed per-owner (a member's own chat history)
  title: z.string(),
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
// resolves into context, and to a list endpoint the composer's mention picker browses.
export const AGENT_REFERENCE_TYPES = ["harness", "runtime", "run", "dataset", "scorecard", "judge", "view"] as const;
export const AgentReferenceTypeSchema = z.enum(AGENT_REFERENCE_TYPES);
export type AgentReferenceType = z.infer<typeof AgentReferenceTypeSchema>;

// An @-mention on a user turn — the entity whose context the agent is handed. label is the display text the
// composer showed (denormalized so the transcript renders the chip without re-fetching).
export const AgentReferenceSchema = z.object({
  type: AgentReferenceTypeSchema,
  id: z.string(),
  version: z.string().optional(),
  label: z.string(),
});
export type AgentReference = z.infer<typeof AgentReferenceSchema>;

// One transcript message. `role` mirrors the chat protocol: a `user` turn, an `assistant` reply (text and/or
// tool_calls), or a `tool` result answering an assistant tool_call. `seq` orders the transcript within a session.
export const AgentMessageRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
  toolCalls: z.array(AgentToolCallSchema).optional(), // assistant turns that requested tools
  toolCallId: z.string().optional(), // tool turns: the assistant tool_call this answers
  name: z.string().optional(), // tool turns: the tool name (for display)
  references: z.array(AgentReferenceSchema).optional(), // user turns: the entities @-referenced this turn
  createdAt: z.string(),
});
export type AgentMessageRecord = z.infer<typeof AgentMessageRecordSchema>;
