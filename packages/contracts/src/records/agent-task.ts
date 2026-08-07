import { z } from "zod";

// The workspace TASK LEDGER — the cross-turn, cross-agent coordination substrate (docs/architecture/agent-teams.md;
// Claude Code's TaskCreate/TaskList tool family reinterpreted server-side). A task is a unit of intended work that
// outlives any one conversation: members and agents create tasks, claim them, chain them with blockedBy, and
// complete them — and the ledger's lifecycle facts (task.created / task.completed) are trigger-matchable, so a
// teammate agent can wake when new work appears or a dependency clears. Deliberately WORKSPACE-SHARED (no private
// tier): a coordination ledger only coordinates what everyone can see.
export const AgentTaskStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"]);
export type AgentTaskStatus = z.infer<typeof AgentTaskStatusSchema>;

export const AgentTaskRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  // Imperative title ("Run the baseline on web@2.2.0") — the unit of work, not a description of activity.
  subject: z.string(),
  description: z.string().optional(),
  status: AgentTaskStatusSchema,
  // Who currently holds it — a member subject or an agent id (free-form actor label; claiming sets it).
  owner: z.string().optional(),
  // Task ids that should complete first. INFORMATIONAL in v1: the ledger records the dependency, readers
  // (agents, the fleet view) decide ordering — the control plane does not block a claim on it.
  blockedBy: z.array(z.string()).default([]),
  // What completing it PRODUCED — the completer's report back to whoever waits on the task (LESSON 059 P1:
  // a task is a unit of delegated work, not just intent, so completion carries results). The requester that
  // parked on task.completed reads it with get_task after the wake; completing without output hands back a
  // bare "done".
  output: z.string().optional(),
  createdBy: z.string(),
  // Agent attribution when a conversation created the task (the causedBy loop guard keys on it).
  origin: z
    .object({
      agentId: z.string().optional(),
      conversationId: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentTaskRecord = z.infer<typeof AgentTaskRecordSchema>;
