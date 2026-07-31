import { InitiativeStatusSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// MCP twin of the initiative routes (BFF↔MCP parity). The tool an agent reaches for when asked "can we ship":
// get_initiative returns the readiness verdict already computed across every project's issues.
export function registerInitiativeTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.initiativeService) return;
  const initiatives = deps.initiativeService;
  const actor = { subject: principal.subject };

  server.registerTool(
    "create_initiative",
    {
      description:
        "Create an initiative — the deployment umbrella over projects, the level at which 'can we ship' is " +
        "asked. Use it for a release or milestone that several projects feed; a single project needs no " +
        "initiative. It starts `active`. Projects join it from the project side (create_project/update_project " +
        "with initiativeId).",
      inputSchema: {
        name: z.string().min(1).max(300),
        description: z.string().max(50_000).optional(),
        targetDate: CalendarDate.optional().describe("YYYY-MM-DD — the intended ship date"),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await initiatives.create({
            tenant: ws,
            createdBy: principal.subject,
            name: a.name,
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.targetDate !== undefined ? { targetDate: a.targetDate } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_initiatives",
    {
      description:
        "The workspace's initiatives, filterable by status (active | completed | cancelled). Rows carry no " +
        "readiness — that verdict fans out over every project's issues, so call get_initiative for one.",
      inputSchema: {
        status: InitiativeStatusSchema.optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    (a) =>
      run(principal, "issues:read", async () =>
        ok(
          await initiatives.list(ws, {
            ...(a.status !== undefined ? { status: a.status } : {}),
            ...(a.limit !== undefined ? { limit: a.limit } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_initiative",
    {
      description:
        "One initiative plus its release readiness: every project under it with that project's issue rollup, " +
        "the total open count, and the specific blocking issues (capped). Open issues are counted across every " +
        "non-cancelled project REGARDLESS of that project's own status — a project marked completed whose issue " +
        "later regressed still blocks the release. This is the read that answers 'can we ship'.",
      inputSchema: { id: z.string() },
    },
    (a) => run(principal, "issues:read", async () => ok(await initiatives.detail(ws, a.id))),
  );

  server.registerTool(
    "update_initiative",
    {
      description:
        "Edit an initiative's content (name, description, target date). Status moves use set_initiative_status " +
        "instead, and projects are attached from the project side. Pass null to clear description/targetDate.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(300).optional(),
        description: z.string().max(50_000).nullable().optional(),
        targetDate: CalendarDate.nullable().optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        const { id, ...fields } = a;
        return ok(await initiatives.update(ws, id, fields, actor));
      }),
  );

  server.registerTool(
    "set_initiative_status",
    {
      description:
        "Move an initiative through its lifecycle. Completing it is the RELEASE GATE: it reads live readiness " +
        "and is refused while any issue under any of its projects is still open, with the count in the error. " +
        "Pass force:true to complete despite the blockers — that override is recorded, so the history says the " +
        "release shipped with known gaps instead of clean. Call get_initiative first and report the blockers " +
        "rather than forcing on your own initiative.",
      inputSchema: {
        id: z.string(),
        status: InitiativeStatusSchema,
        force: z.boolean().optional().describe("complete despite open issues — recorded as a forced completion"),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await initiatives.setStatus(
            ws,
            a.id,
            { status: a.status, ...(a.force !== undefined ? { force: a.force } : {}) },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_initiative",
    {
      description:
        "Delete an initiative. Refused while projects still sit under it — move them out first. Creator or " +
        "workspace admin only.",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        await initiatives.remove(ws, a.id, { subject: principal.subject, isAdmin: principal.roles.includes("admin") });
        return ok({ deleted: a.id });
      }),
  );
}
