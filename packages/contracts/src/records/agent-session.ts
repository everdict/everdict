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
  createdAt: z.string(),
});
export type AgentMessageRecord = z.infer<typeof AgentMessageRecordSchema>;
