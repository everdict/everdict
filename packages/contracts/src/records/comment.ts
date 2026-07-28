import { z } from "zod";

// An agent-authored comment's lifecycle: running (turn in flight) → awaiting_approval (parked on a HITL write-tool
// ask) → complete (final answer in body) | failed. Only present when authorKind is "agent".
export const CommentAgentStatusSchema = z.enum(["running", "awaiting_approval", "complete", "failed"]);
export type CommentAgentStatus = z.infer<typeof CommentAgentStatusSchema>;

// Comments on a resource (dataset etc.) — collaborative discussion, like Linear issue comments. Flows mixed with events in the activity timeline.
// resourceType is extensible (currently "dataset"). Workspace-scoped + author=author subject.
export const CommentRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  resourceType: z.string(), // "dataset"|"harness"|"scorecard"|"view"|"schedule"|"run"|"runtime"
  resourceId: z.string(),
  parentId: z.string().optional(), // if a reply, the parent comment id (same resource, only top-level can be a parent — one-level thread). Absent = top-level.
  author: z.string(), // author subject (agent comments use the reserved sentinel "everdict:agent")
  body: z.string(), // agent comments: empty while running, the final markdown answer when complete
  // Agent-answer fields (@everdict in the thread) — absent on ordinary member comments.
  authorKind: z.enum(["user", "agent"]).optional(), // absent = user
  agentStatus: CommentAgentStatusSchema.optional(),
  // Machine-readable "doing now" token while running: "thinking" | "writing" | "tool:<name>". The web localizes it.
  agentActivity: z.string().optional(),
  agentSessionId: z.string().optional(), // the backing agent conversation (workspace-visible) — the detail/continue surface
  agentAskedBy: z.string().optional(), // the asking member's subject — the completion notification's recipient
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CommentRecord = z.infer<typeof CommentRecordSchema>;
