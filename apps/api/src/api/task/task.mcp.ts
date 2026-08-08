import { AgentTaskStatusSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// MCP twin of the task-ledger routes (BFF↔MCP parity) — the transport agents actually coordinate through.
// ctx.agent (the conversation's attribution) rides into the service so agent-created/claimed tasks stamp
// causedBy: the creator never wakes on its own task; a TEAMMATE subscribed to task.created/completed does.
export function registerTaskTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.taskService) return;
  const tasks = deps.taskService;
  const agent = ctx.agent?.agentId
    ? {
        agentId: ctx.agent.agentId,
        ...(ctx.agent.conversationId !== undefined ? { conversationId: ctx.agent.conversationId } : {}),
      }
    : undefined;

  server.registerTool(
    "create_task",
    {
      annotations: { readOnlyHint: false },
      description:
        "Add a unit of intended work to the workspace's shared TASK LEDGER — the cross-conversation, cross-agent " +
        "coordination substrate. Use it to hand work to teammates or to your future self: tasks outlive this " +
        "conversation, and teammate agents subscribed to task.created wake when new work appears. To DELEGATE " +
        "and be resumed when it is done: create the task (set owner to the teammate so its wake names the " +
        "assignee), then wait_for kinds [\"task.completed\"] with filter {field:'id', op:'eq', value:<this " +
        "task's id>} — on wake, get_task and read its output (the completer's report). blockedBy " +
        "chains it behind other task ids (informational — readers decide ordering). subject is an imperative " +
        "title ('Run the baseline on web@2.2.0').",
      inputSchema: {
        subject: z.string().min(1).max(300),
        description: z.string().max(10_000).optional(),
        owner: z.string().optional().describe("pre-assign to a member subject or agent id; else claiming sets it"),
        blockedBy: z.array(z.string()).max(20).optional().describe("task ids that should complete first"),
      },
    },
    (a) =>
      run(principal, "agents:write", async () =>
        ok(
          await tasks.create({
            tenant: ws,
            createdBy: principal.subject,
            subject: a.subject,
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.owner !== undefined ? { owner: a.owner } : {}),
            ...(a.blockedBy !== undefined ? { blockedBy: a.blockedBy } : {}),
            ...(agent ? { agent } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_tasks",
    {
      annotations: { readOnlyHint: true },
      description:
        "The workspace's task ledger, newest activity first — check it BEFORE starting substantial work (someone " +
        "may already own it) and to find work whose blockedBy dependencies have completed. Optional status filter " +
        "(pending | in_progress | completed | cancelled).",
      inputSchema: {
        status: AgentTaskStatusSchema.optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    (a) =>
      run(principal, "agents:read", async () =>
        ok(
          await tasks.list(ws, {
            ...(a.status !== undefined ? { status: a.status } : {}),
            ...(a.limit !== undefined ? { limit: a.limit } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_task",
    {
      annotations: { readOnlyHint: true },
      description: "Read one ledger task by id.",
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(principal, "agents:read", async () => ok(await tasks.get(ws, id))),
  );

  server.registerTool(
    "update_task",
    {
      annotations: { readOnlyHint: false },
      description:
        "Patch a ledger task — CLAIM it (status=in_progress; you become the owner when none is set — a task " +
        "already claimed by someone else refuses with 409, stand down and pull other work), COMPLETE it " +
        "(status=completed WITH your results in `output` — the task.completed fact wakes whoever parked on this " +
        "task, and your output is the report they read; completing without output hands back a bare 'done'), " +
        "cancel it, or edit subject/description/owner/blockedBy. A same-status patch emits no fact.",
      inputSchema: {
        id: z.string(),
        subject: z.string().min(1).max(300).optional(),
        description: z.string().max(10_000).optional(),
        status: AgentTaskStatusSchema.optional(),
        owner: z.string().optional(),
        blockedBy: z.array(z.string()).max(20).optional(),
        output: z
          .string()
          .max(50_000)
          .optional()
          .describe("your results, for whoever waits on this task — set it when completing"),
      },
    },
    ({ id, ...patch }) =>
      run(principal, "agents:write", async () =>
        ok(
          await tasks.update(
            ws,
            id,
            {
              ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
              ...(patch.description !== undefined ? { description: patch.description } : {}),
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
              ...(patch.blockedBy !== undefined ? { blockedBy: patch.blockedBy } : {}),
              ...(patch.output !== undefined ? { output: patch.output } : {}),
            },
            { subject: principal.subject, ...(agent ? { agent } : {}) },
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_task",
    {
      annotations: { readOnlyHint: false },
      description: "Delete a ledger task — its creator or a workspace admin only (prefer cancelling over deleting).",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(principal, "agents:write", async () => {
        await tasks.remove(ws, id, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        });
        return ok({ deleted: id });
      }),
  );
}
