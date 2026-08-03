import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, resolveTeam, run } from "../mcp-context.js";

// MCP twin of the cycle routes (BFF↔MCP parity). An agent uses these to answer "what is this team working on
// right now" and to write the iteration summary when a cycle closes.
export function registerCycleTools(server: McpServer, ctx: McpToolContext): void {
  const cycles = ctx.deps.cycleService;
  if (!cycles) return;
  const { principal } = ctx;
  const ws = principal.workspace;
  const actor = { subject: principal.subject };

  server.registerTool(
    "create_cycle",
    {
      description:
        "Plan a team's next iteration. Omit both dates to take the window proposed from the team's cadence " +
        "(the day after its latest cycle ends, for cycleDurationWeeks); pass both to name your own — one alone " +
        "is refused. The number comes from the team's own sequence, so `Cycle 7` is that team's seventh.",
      inputSchema: {
        teamId: z.string(),
        name: z.string().max(200).optional().describe("most cycles are just their number; a name carries a theme"),
        description: z.string().max(2000).optional(),
        startsAt: z.string().optional().describe("YYYY-MM-DD"),
        endsAt: z.string().optional().describe("YYYY-MM-DD, inclusive"),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await cycles.create({
            tenant: ws,
            createdBy: principal.subject,
            teamId: await resolveTeam(ctx, a.teamId),
            ...(a.name !== undefined ? { name: a.name } : {}),
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.startsAt !== undefined ? { startsAt: a.startsAt } : {}),
            ...(a.endsAt !== undefined ? { endsAt: a.endsAt } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_cycles",
    {
      description:
        "A workspace's cycles, newest iteration first. `team` narrows to one team's; `open: true` returns the " +
        "ones nobody has closed — which is the absence of an explicit close, NOT a passed end date, so a cycle " +
        "somebody forgot still appears. Rows carry no progress; call get_cycle for that.",
      inputSchema: {
        team: z.string().optional(),
        open: z.boolean().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    (a) =>
      run(principal, "issues:read", async () =>
        ok(
          await cycles.list(ws, {
            ...(a.team !== undefined ? { teamId: await resolveTeam(ctx, a.team) } : {}),
            ...(a.open === true ? { open: true } : {}),
            ...(a.limit !== undefined ? { limit: a.limit } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_cycle",
    {
      description:
        "One cycle plus its derived state (upcoming | active | completed) and what it holds: issue counts and " +
        "POINTS (scope / completedScope from the estimates). Counts count issues, points count estimates — an " +
        "unestimated issue is real work worth zero points. This is the read behind 'how is the sprint going'.",
      inputSchema: { id: z.string() },
    },
    (a) => run(principal, "issues:read", async () => ok(await cycles.detail(ws, a.id))),
  );

  server.registerTool(
    "update_cycle",
    {
      description:
        "Rename, re-describe or move a cycle's window. A CLOSED cycle refuses every edit — a finished iteration " +
        "is a record, not a plan. Pass null to clear the name/description.",
      inputSchema: {
        id: z.string(),
        name: z.string().max(200).nullable().optional(),
        description: z.string().max(2000).nullable().optional(),
        startsAt: z.string().optional(),
        endsAt: z.string().optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        const { id, ...fields } = a;
        return ok(await cycles.update(ws, id, fields, actor));
      }),
  );

  server.registerTool(
    "complete_cycle",
    {
      description:
        "Close an iteration. With `moveUnfinishedTo`, everything still open is carried into another OPEN cycle " +
        "of the SAME team in the same operation. This is NOT a gate — an iteration ending with unfinished work " +
        "is the normal case — and the emitted fact carries `carriedOver`, the number a retro asks for.",
      inputSchema: {
        id: z.string(),
        moveUnfinishedTo: z.string().optional().describe("an open cycle of the same team"),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await cycles.complete(
            ws,
            a.id,
            { ...(a.moveUnfinishedTo !== undefined ? { moveUnfinishedTo: a.moveUnfinishedTo } : {}) },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_cycle",
    {
      description:
        "Delete a cycle. Creator or workspace admin only, and a cycle that still holds issues is refused — move " +
        "them to another iteration first.",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        await cycles.remove(ws, a.id, { subject: principal.subject, isAdmin: principal.roles.includes("admin") });
        return ok({ deleted: a.id });
      }),
  );
}
