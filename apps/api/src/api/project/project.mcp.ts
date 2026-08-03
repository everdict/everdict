import { ProjectHealthSchema, ProjectStatusSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, resolveTeam, run } from "../mcp-context.js";

const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// MCP twin of the project routes (BFF↔MCP parity). This is how an agent answers "is this batch of work
// finishable by its date" without reading every issue: the detail read returns the rollup already counted.
export function registerProjectTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.projectService) return;
  const projects = deps.projectService;
  const actor = { subject: principal.subject };

  server.registerTool(
    "create_project",
    {
      description:
        "Create a project — the tracker's container for issues that share one target date, optionally under an " +
        "initiative. Use it when work spans several issues that ship together; a single issue needs no project. " +
        "The project starts `planned`, and set_project_status moves it from there.",
      inputSchema: {
        name: z.string().min(1).max(300),
        description: z.string().max(50_000).optional(),
        lead: z.string().optional().describe("who is answerable for it"),
        memberIds: z.array(z.string()).optional(),
        teamIds: z
          .array(z.string())
          .optional()
          .describe("the teams contributing — omit to land it on the workspace's default team"),
        initiativeIds: z
          .array(z.string())
          .optional()
          .describe("the initiative umbrellas this project ships under; a project may serve several"),
        targetDate: CalendarDate.optional().describe("YYYY-MM-DD — the date the project is meant to be done by"),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await projects.create({
            tenant: ws,
            createdBy: principal.subject,
            name: a.name,
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.lead !== undefined ? { lead: a.lead } : {}),
            ...(a.memberIds !== undefined ? { memberIds: a.memberIds } : {}),
            ...(a.teamIds !== undefined ? { teamIds: a.teamIds } : {}),
            ...(a.initiativeIds !== undefined ? { initiativeIds: a.initiativeIds } : {}),
            ...(a.targetDate !== undefined ? { targetDate: a.targetDate } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_projects",
    {
      description:
        "The workspace's projects. Filter by status (planned | in_progress | completed | cancelled), by the " +
        "initiative they sit under, or by the TEAM working them (a project names its teams, so this answers " +
        "what the team is on even before its first issue). Rows carry no issue counts — call get_project.",
      inputSchema: {
        status: ProjectStatusSchema.optional(),
        initiative: z.string().optional().describe("only projects under this initiative id"),
        team: z.string().optional().describe("only projects this team contributes to"),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    (a) =>
      run(principal, "issues:read", async () =>
        ok(
          await projects.list(ws, {
            ...(a.status !== undefined ? { status: a.status } : {}),
            ...(a.initiative !== undefined ? { initiativeId: a.initiative } : {}),
            ...(a.team !== undefined ? { teamId: await resolveTeam(ctx, a.team) } : {}),
            ...(a.limit !== undefined ? { limit: a.limit } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_project",
    {
      description:
        "One project plus the live rollup of its issues: total, open, done, cancelled, and `evaluated` (done " +
        "AND closed with a scorecard — 'resolved' and 'resolved with evidence' are different claims). " +
        "`ready` is true when nothing is open, which is exactly what completing the project requires.",
      inputSchema: { id: z.string() },
    },
    (a) => run(principal, "issues:read", async () => ok(await projects.detail(ws, a.id))),
  );

  server.registerTool(
    "update_project",
    {
      description:
        "Edit a project's content (name, description, teams, initiatives, target date). Status moves use " +
        "set_project_status instead. Pass null to clear description/targetDate; a LIST replaces what is there, " +
        "so pass [] to detach every team or every initiative.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(300).optional(),
        description: z.string().max(50_000).nullable().optional(),
        teamIds: z.array(z.string()).optional(),
        initiativeIds: z.array(z.string()).optional(),
        targetDate: CalendarDate.nullable().optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        const { id, ...fields } = a;
        return ok(await projects.update(ws, id, fields, actor));
      }),
  );

  server.registerTool(
    "post_project_update",
    {
      description:
        "Post a project update — the one JUDGMENT the tracker records. `health` is on_track | at_risk | " +
        "off_track and the BODY is required: a health flag with no sentence is a colour nobody can explain. " +
        "The project keeps the latest health, and the emitted fact is trigger-matchable, so 'wake me when a " +
        "project goes off track' is a payload filter on it.",
      inputSchema: {
        id: z.string(),
        health: ProjectHealthSchema,
        body: z.string().min(1).max(50_000).describe("what changed, and why it reads that way"),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(await projects.postUpdate(ws, a.id, { health: a.health, body: a.body }, actor)),
      ),
  );

  server.registerTool(
    "list_project_updates",
    {
      description:
        "The project's posted updates, newest first. This is where the health colour is EXPLAINED — read it " +
        "before reporting on a project whose status you did not watch change.",
      inputSchema: { id: z.string(), limit: z.number().int().positive().max(100).optional() },
    },
    (a) => run(principal, "issues:read", async () => ok(await projects.listUpdates(ws, a.id, a.limit ?? 20))),
  );

  server.registerTool(
    "add_project_milestone",
    {
      description:
        "Add a checkpoint inside a project. Order is the meaning (milestones are steps toward a date), so a " +
        "new one goes at the end. A duplicate name is refused. Issues join a milestone through update_issue.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        targetDate: CalendarDate.optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        const { id, ...milestone } = a;
        return ok(await projects.addMilestone(ws, id, milestone, actor));
      }),
  );

  server.registerTool(
    "remove_project_milestone",
    {
      description:
        "Remove a checkpoint. Every issue that pointed at it is DETACHED in the same operation, so no issue is " +
        "left naming a milestone that no longer exists.",
      inputSchema: { id: z.string(), milestoneId: z.string() },
    },
    (a) =>
      run(principal, "issues:write", async () => ok(await projects.removeMilestone(ws, a.id, a.milestoneId, actor))),
  );

  server.registerTool(
    "set_project_status",
    {
      description:
        "Move a project through its lifecycle. Completing it is a GATE: it is refused while any of the " +
        "project's issues are still open, and the refusal names the count. Pass force:true to complete anyway " +
        "(a release that ships with known gaps) — the override is recorded, so the history says the deadline " +
        "was overridden, not met. Read get_project first: `rollup.ready` tells you whether force is needed.",
      inputSchema: {
        id: z.string(),
        status: ProjectStatusSchema,
        force: z.boolean().optional().describe("complete despite open issues — recorded as a forced completion"),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await projects.setStatus(
            ws,
            a.id,
            { status: a.status, ...(a.force !== undefined ? { force: a.force } : {}) },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_project",
    {
      description:
        "Delete a project. Refused while it still holds issues — deleting the container would orphan them, so " +
        "move them to another project first. Creator or workspace admin only.",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        await projects.remove(ws, a.id, { subject: principal.subject, isAdmin: principal.roles.includes("admin") });
        return ok({ deleted: a.id });
      }),
  );
}
