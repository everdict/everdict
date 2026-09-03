import { InitiativeStatusSchema, TrackerHealthSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// MCP twin of the initiative routes (BFF↔MCP parity). The tool an agent reaches for when asked "where does this
// goal stand": get_initiative returns the progress already computed across every project's issues.
export function registerInitiativeTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.initiativeService) return;
  const initiatives = deps.initiativeService;
  const actor = { subject: principal.subject };

  server.registerTool(
    "create_initiative",
    {
      annotations: { readOnlyHint: false },
      description:
        "Create an initiative — a GOAL several projects work toward, the level at which 'where does this stand' " +
        "is asked. Use it for an outcome that several projects feed (a quality bar, a cost target, a migration); " +
        "a single project needs no initiative. It starts `planned` — moving it to `active` is the moment work " +
        "under it begins, and both that and completion go through set_initiative_status. Projects join it from " +
        "the project side (create_project/update_project with initiativeIds), and an initiative may itself sit " +
        "under another one.",
      inputSchema: {
        name: z.string().min(1).max(300),
        description: z.string().max(50_000).optional(),
        parentId: z
          .string()
          .optional()
          .describe("roll this initiative up into another one — the parent's progress then covers it too"),
        lead: z.string().optional().describe("the subject answerable for the goal"),
        memberIds: z.array(z.string()).optional().describe("who else is on it"),
        icon: z.string().max(8).optional().describe("one emoji — how the goal is recognized in a list"),
        resources: z
          .array(z.object({ label: z.string(), url: z.string() }))
          .optional()
          .describe("where the goal is written down, measured or argued"),
        targetDate: CalendarDate.optional().describe("YYYY-MM-DD — when the goal is meant to be reached"),
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
            ...(a.parentId !== undefined ? { parentId: a.parentId } : {}),
            ...(a.lead !== undefined ? { lead: a.lead } : {}),
            ...(a.memberIds !== undefined ? { memberIds: a.memberIds } : {}),
            ...(a.icon !== undefined ? { icon: a.icon } : {}),
            ...(a.resources !== undefined ? { resources: a.resources } : {}),
            ...(a.targetDate !== undefined ? { targetDate: a.targetDate } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_initiatives",
    {
      annotations: { readOnlyHint: true },
      description:
        "The workspace's initiatives, filterable by status (active | completed | cancelled). Rows carry the " +
        "latest reported health but no progress — that fans out over every project's issues, so call " +
        "get_initiative for one.",
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
      annotations: { readOnlyHint: true },
      description:
        "One initiative plus how far along the goal is: every project under it OR under any sub-initiative, " +
        "with that project's status, reported health, lead and issue rollup (`viaInitiativeId` names the " +
        "descendant a project came up through), the total open count, and the specific issues still to finish " +
        "(capped). Open issues are counted across every non-cancelled project REGARDLESS of that project's own " +
        "status — a project marked completed whose issue later regressed is still unfinished work under the " +
        "goal. This is the read that answers 'where does this goal stand'.",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "issues:read", async () =>
        // The goal is workspace-level; what narrows is which projects and blockers under it are NAMED.
        ok(await initiatives.detail(ws, a.id)),
      ),
  );

  server.registerTool(
    "update_initiative",
    {
      annotations: { readOnlyHint: false },
      description:
        "Edit an initiative's content (name, description, parent, lead, members, icon, resources, target " +
        "date). Status moves use " +
        "set_initiative_status instead, and projects are attached from the project side. Pass null to clear " +
        "description/lead/targetDate/parentId (detaching it back to the top level). Re-parenting under one of " +
        "its own descendants is refused — that would make the progress roll-up circular.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(300).optional(),
        description: z.string().max(50_000).nullable().optional(),
        parentId: z.string().nullable().optional(),
        lead: z.string().nullable().optional(),
        memberIds: z.array(z.string()).optional(),
        icon: z.string().max(8).nullable().optional(),
        resources: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
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
    "post_initiative_update",
    {
      annotations: { readOnlyHint: false },
      description:
        "Report where the GOAL stands: `health` (on_track | at_risk | off_track) WITH the sentence that " +
        "explains it — the body is required, because a health flag with no sentence is a colour nobody can " +
        "explain. This is the judgment layer over the arithmetic: get_initiative says what is open, an update " +
        "says what that means. Emits initiative.update_posted, so 'wake me when this goal slips' is a payload " +
        "filter.",
      inputSchema: {
        id: z.string(),
        health: TrackerHealthSchema,
        body: z.string().min(1).max(50_000),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(await initiatives.postUpdate(ws, a.id, { health: a.health, body: a.body }, actor)),
      ),
  );

  server.registerTool(
    "list_initiative_updates",
    {
      annotations: { readOnlyHint: true },
      description:
        "The initiative's posted updates, newest first. This is where the health colour is EXPLAINED — read it " +
        "before reporting on a goal, so the summary quotes what the lead actually said.",
      inputSchema: { id: z.string(), limit: z.number().int().positive().max(100).optional() },
    },
    (a) => run(principal, "issues:read", async () => ok(await initiatives.listUpdates(ws, a.id, a.limit ?? 20))),
  );

  server.registerTool(
    "set_initiative_status",
    {
      annotations: { readOnlyHint: false },
      description:
        "Move an initiative through its lifecycle (planned → active → completed, or cancelled). Completing " +
        "it is a GATE: it reads live progress and is " +
        "refused while any issue under any of its projects is still open, with the count in the error. Pass " +
        "force:true to complete despite that — the override is recorded, so the history says the goal was " +
        "closed with known gaps instead of reached. Call get_initiative first and report what is left rather " +
        "than forcing on your own initiative.",
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
      annotations: { readOnlyHint: false },
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
