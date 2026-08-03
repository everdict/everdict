import { IssueLinkTypeSchema, IssueStatusSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// MCP twin of the issue routes (BFF↔MCP parity). This is the surface an agent uses to triage its own
// regressions: find the issue that watches a harness, read how it was closed last time, and move it.
// ctx.agent rides into the service so an agent's transitions stamp causedBy — the trigger loop guard.
export function registerIssueTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.issueService) return;
  const issues = deps.issueService;
  const agent = ctx.agent?.agentId
    ? {
        agentId: ctx.agent.agentId,
        ...(ctx.agent.conversationId !== undefined ? { conversationId: ctx.agent.conversationId } : {}),
      }
    : undefined;
  const actor = { subject: principal.subject, ...(agent ? { agent } : {}) };

  server.registerTool(
    "create_issue",
    {
      description:
        "File an issue on the eval tracker — the record of WHAT problem is under evaluation and why. Link the " +
        "harnesses/datasets/judges that verify it so the issue accumulates its own evaluation history. Use this " +
        "when you find a defect worth tracking across runs, not for one-off notes.",
      inputSchema: {
        title: z.string().min(1).max(300),
        description: z.string().max(50_000).optional(),
        status: IssueStatusSchema.exclude(["done", "regressed"]).optional(),
        projectId: z.string().optional().describe("the project this issue belongs to"),
        assignee: z.string().optional(),
        labelIds: z.array(z.string()).max(50).optional(),
        links: z
          .array(
            z.object({
              type: IssueLinkTypeSchema,
              id: z.string(),
              version: z.string().optional(),
              note: z.string().max(500).optional(),
            }),
          )
          .max(50)
          .optional()
          .describe("capabilities that verify this issue (harness/dataset/judge/scorecard/run/view)"),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await issues.create({
            tenant: ws,
            createdBy: principal.subject,
            title: a.title,
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.status !== undefined ? { status: a.status } : {}),
            ...(a.projectId !== undefined ? { projectId: a.projectId } : {}),
            ...(a.assignee !== undefined ? { assignee: a.assignee } : {}),
            ...(a.labelIds !== undefined ? { labelIds: a.labelIds } : {}),
            ...(a.links !== undefined ? { links: a.links } : {}),
            ...(agent ? { agent } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_issues",
    {
      description:
        "The workspace's issues, newest activity first. Filter by status (backlog | todo | in_progress | " +
        "in_review | done | cancelled | regressed), project, assignee, or by the capability an issue links " +
        "(linkType + linkId) — that last one answers 'which issues watch this harness/dataset', the lookup to " +
        "run before investigating a failing batch.",
      inputSchema: {
        status: IssueStatusSchema.optional(),
        project: z.string().optional(),
        assignee: z.string().optional(),
        linkType: IssueLinkTypeSchema.optional(),
        linkId: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    (a) =>
      run(principal, "issues:read", async () =>
        ok(
          await issues.list(ws, {
            ...(a.status !== undefined ? { status: a.status } : {}),
            ...(a.project !== undefined ? { projectId: a.project } : {}),
            ...(a.assignee !== undefined ? { assignee: a.assignee } : {}),
            ...(a.linkType !== undefined && a.linkId !== undefined ? { link: { type: a.linkType, id: a.linkId } } : {}),
            ...(a.limit !== undefined ? { limit: a.limit } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_issue",
    {
      description:
        "One issue in full — its links, how it was resolved (including the scorecard that proved it), its " +
        "GitHub copy, and the durable history of every move. Read this before re-investigating something the " +
        "team already closed.",
      inputSchema: { id: z.string().describe("issue id, or the identifier a member would name it by (ENG-12)") },
    },
    (a) => run(principal, "issues:read", async () => ok(await issues.get(ws, a.id))),
  );

  server.registerTool(
    "update_issue",
    {
      description:
        "Edit an issue's content (title, description, labels, assignee, project). Status moves use " +
        "set_issue_status instead. Pass null to clear assignee/projectId/description.",
      inputSchema: {
        id: z.string(),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(50_000).nullable().optional(),
        labelIds: z.array(z.string()).max(50).optional(),
        assignee: z.string().nullable().optional(),
        projectId: z.string().nullable().optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        const { id, ...fields } = a;
        return ok(await issues.update(ws, id, fields, actor));
      }),
  );

  server.registerTool(
    "set_issue_status",
    {
      description:
        "Move an issue through the workflow — say where it should end up and the control plane picks the right " +
        "transition. Closing (status=done) REQUIRES saying how it was evaluated: pass resolution.scorecardId " +
        "with the batch that proved it, which becomes the baseline a later regression is measured against. " +
        "Reopening a done issue with status=regressed is how a fallen resolution is recorded. An illegal move " +
        "(e.g. resolving an already-closed issue) is rejected — read the issue first.",
      inputSchema: {
        id: z.string(),
        status: IssueStatusSchema,
        resolution: z
          .object({ scorecardId: z.string().optional(), note: z.string().max(2000).optional() })
          .optional()
          .describe("required when closing — the evidence the issue is fixed"),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await issues.setStatus(
            ws,
            a.id,
            { status: a.status, ...(a.resolution !== undefined ? { resolution: a.resolution } : {}) },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "add_issue_link",
    {
      description:
        "Attach a capability (harness/dataset/judge/scorecard/run/view) to an issue. Dataset and harness links " +
        "widen the issue's evaluation history to every batch that exercised them, which is how a regression " +
        "against a closed issue surfaces.",
      inputSchema: {
        id: z.string(),
        type: IssueLinkTypeSchema,
        linkId: z.string(),
        version: z.string().optional(),
        note: z.string().max(500).optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await issues.link(
            ws,
            a.id,
            {
              type: a.type,
              id: a.linkId,
              ...(a.version !== undefined ? { version: a.version } : {}),
              ...(a.note !== undefined ? { note: a.note } : {}),
            },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "remove_issue_link",
    {
      description: "Detach a capability from an issue.",
      inputSchema: { id: z.string(), type: IssueLinkTypeSchema, linkId: z.string() },
    },
    (a) => run(principal, "issues:write", async () => ok(await issues.unlink(ws, a.id, a.type, a.linkId, actor))),
  );

  server.registerTool(
    "list_issue_scorecards",
    {
      description:
        "The issue's evaluation history: the scorecards pinned to it as evidence UNION every batch its linked " +
        "datasets/harnesses ran, newest first. Compare the latest against the resolution scorecard to judge " +
        "whether a closed issue has regressed.",
      inputSchema: { id: z.string() },
    },
    (a) => run(principal, "scorecards:read", async () => ok(await issues.evaluationHistory(ws, a.id))),
  );

  server.registerTool(
    "delete_issue",
    {
      description: "Delete an issue. Creator or workspace admin only.",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        await issues.remove(ws, a.id, { subject: principal.subject, isAdmin: principal.roles.includes("admin") });
        return ok({ deleted: a.id });
      }),
  );
}
