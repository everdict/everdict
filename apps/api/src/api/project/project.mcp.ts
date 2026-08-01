import { ProjectStatusSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

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
        initiativeId: z.string().optional().describe("the initiative umbrella this project ships under"),
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
            ...(a.initiativeId !== undefined ? { initiativeId: a.initiativeId } : {}),
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
        "initiative they sit under, or by the TEAM working them — a project has no team of its own, so `team` " +
        "means the projects that team has issues in. Rows carry no issue counts — call get_project for one.",
      inputSchema: {
        status: ProjectStatusSchema.optional(),
        initiative: z.string().optional().describe("only projects under this initiative id"),
        team: z.string().optional().describe("only projects this team has issues in"),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    (a) =>
      run(principal, "issues:read", async () =>
        ok(
          await projects.list(ws, {
            ...(a.status !== undefined ? { status: a.status } : {}),
            ...(a.initiative !== undefined ? { initiativeId: a.initiative } : {}),
            ...(a.team !== undefined ? { teamId: a.team } : {}),
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
        "Edit a project's content (name, description, owning initiative, target date). Status moves use " +
        "set_project_status instead. Pass null to clear description/initiativeId/targetDate.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(300).optional(),
        description: z.string().max(50_000).nullable().optional(),
        initiativeId: z.string().nullable().optional(),
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
