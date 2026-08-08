import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { visibleTeamsFor } from "../../common/team-scope.js";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// MCP twin of the team routes (BFF↔MCP parity). An agent triaging the tracker needs to know which team owns
// what before it files anything — `list_teams` is how it finds the prefix its issue will be named under.
export function registerTeamTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.teamService) return;
  const teams = deps.teamService;
  const actor = { subject: principal.subject, isAdmin: principal.roles.includes("admin") };

  server.registerTool(
    "list_teams",
    {
      annotations: { readOnlyHint: true },
      description:
        "List the workspace's teams. A team owns issues and names them (ENG-12); one team is the default, " +
        "which is where an issue filed without a team lands. Each row carries a derived summary (roster size, " +
        "open/total issues). Use `mine` to see only the teams you belong to.",
      inputSchema: { mine: z.boolean().optional() },
    },
    (a) =>
      run(principal, "teams:read", async () => {
        await teams.ensureDefault(ws, principal.subject);
        const rows = await teams.list(ws, { ...(a.mine === true ? { member: principal.subject } : {}) });
        // A private team is not on the workspace's list for people outside it — same as the HTTP read.
        const seen = await visibleTeamsFor(ctx.deps, principal);
        const visible = seen === undefined ? rows : rows.filter((team) => seen.includes(team.id));
        // Batched exactly like the HTTP twin — the counts come from two workspace aggregates, not a read per row.
        const summaries = await teams.summaries(
          ws,
          visible.map((team) => team.id),
        );
        return ok(visible.map((team) => ({ ...team, summary: summaries.get(team.id) })));
      }),
  );

  server.registerTool(
    "get_team",
    {
      annotations: { readOnlyHint: true },
      description: "Read one team plus its derived summary. A team in another workspace reads as not found.",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "teams:read", async () => {
        const team = await teams.get(ws, a.id);
        return ok({ ...team, summary: await teams.summary(ws, team.id) });
      }),
  );

  server.registerTool(
    "create_team",
    {
      annotations: { readOnlyHint: false },
      description:
        "Create a team with an immutable identifier prefix (the `key`, e.g. ENG → ENG-1, ENG-2). The first " +
        "team in a workspace is the default whatever you ask for, because an issue filed without a team has " +
        "to land somewhere. Requires admin.",
      inputSchema: {
        key: z.string().min(2).max(6).describe("identifier prefix, e.g. ENG — uppercase, immutable"),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        isDefault: z.boolean().optional().describe("promote to the workspace default, demoting the incumbent"),
        parentId: z.string().optional().describe("nest this team under another — organisational only"),
        members: z.array(z.string()).max(200).optional(),
      },
    },
    (a) =>
      run(principal, "teams:write", async () =>
        ok(
          await teams.create({
            tenant: ws,
            createdBy: principal.subject,
            key: a.key,
            name: a.name,
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.parentId !== undefined ? { parentId: a.parentId } : {}),
            ...(a.isDefault !== undefined ? { isDefault: a.isDefault } : {}),
            ...(a.members !== undefined ? { members: a.members } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "update_team",
    {
      annotations: { readOnlyHint: false },
      description:
        "Rename a team, edit its description, re-parent it, or set how it paces itself. The key cannot change " +
        "— it is baked into every identifier the team has already minted. Pass parentId null to detach it back " +
        "to the top level; nesting it under one of its own sub-teams is refused. Turning cyclesEnabled on is " +
        "what makes the team's iterations exist: the next read of its cycle list stands up the one it is in " +
        "plus upcomingCycleCount more. Requires admin.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        parentId: z.string().nullable().optional(),
        cyclesEnabled: z.boolean().optional().describe("whether this team paces itself in iterations at all"),
        cycleDurationWeeks: z.number().int().min(1).max(12).optional().describe("how long one iteration runs"),
        cycleStartDay: z.number().int().min(0).max(6).optional().describe("weekday a cycle starts — 0 = Sunday"),
        upcomingCycleCount: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe("how many future iterations stay provisioned in front of the active one"),
        cycleAutoClose: z
          .boolean()
          .optional()
          .describe("close an iteration when its dates run out, carrying unfinished work into the next one"),
        triageEnabled: z.boolean().optional().describe("queue incoming work in front of the team's workflow"),
      },
    },
    (a) =>
      run(principal, "teams:write", async () =>
        ok(
          await teams.update(
            ws,
            a.id,
            {
              ...(a.name !== undefined ? { name: a.name } : {}),
              ...(a.description !== undefined ? { description: a.description } : {}),
              ...(a.parentId !== undefined ? { parentId: a.parentId } : {}),
              ...(a.cyclesEnabled !== undefined ? { cyclesEnabled: a.cyclesEnabled } : {}),
              ...(a.cycleDurationWeeks !== undefined ? { cycleDurationWeeks: a.cycleDurationWeeks } : {}),
              ...(a.cycleStartDay !== undefined ? { cycleStartDay: a.cycleStartDay } : {}),
              ...(a.upcomingCycleCount !== undefined ? { upcomingCycleCount: a.upcomingCycleCount } : {}),
              ...(a.cycleAutoClose !== undefined ? { cycleAutoClose: a.cycleAutoClose } : {}),
              ...(a.triageEnabled !== undefined ? { triageEnabled: a.triageEnabled } : {}),
            },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "set_default_team",
    {
      annotations: { readOnlyHint: false },
      description:
        "Hand the default flag to this team. The incumbent is demoted in the same call, so the workspace is " +
        "never left without a landing place for an unrouted issue. Requires admin.",
      inputSchema: { id: z.string() },
    },
    (a) => run(principal, "teams:write", async () => ok(await teams.makeDefault(ws, a.id, actor))),
  );

  server.registerTool(
    "delete_team",
    {
      annotations: { readOnlyHint: false },
      description:
        "Delete a team. Refused for the default team, for the last remaining team, and for a team that still " +
        "holds issues. Requires admin (or being the creator).",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "teams:write", async () => {
        await teams.remove(ws, a.id, actor);
        return ok({ deleted: a.id });
      }),
  );

  server.registerTool(
    "list_team_members",
    {
      annotations: { readOnlyHint: true },
      description:
        "The team's roster. Team membership is separate from workspace membership — belonging to a team is " +
        "what makes an issue land in your list.",
      inputSchema: { id: z.string() },
    },
    (a) => run(principal, "teams:read", async () => ok(await teams.listMembers(ws, a.id))),
  );

  server.registerTool(
    "add_team_member",
    {
      annotations: { readOnlyHint: false },
      description: "Add a subject to a team's roster. Requires admin.",
      inputSchema: { id: z.string(), subject: z.string() },
    },
    (a) => run(principal, "teams:write", async () => ok(await teams.addMember(ws, a.id, a.subject, actor))),
  );

  server.registerTool(
    "join_team",
    {
      annotations: { readOnlyHint: false },
      description:
        'Join a team YOURSELF (self-service — Linear\'s "Join teams"). Puts the caller on the roster, which ' +
        "is what makes that team's issues land in their list. Already being on the team is a conflict; a " +
        "private team you cannot see reads as not found. Member+.",
      inputSchema: { id: z.string() },
    },
    (a) => run(principal, "teams:join", async () => ok(await teams.join(ws, a.id, actor))),
  );

  server.registerTool(
    "leave_team",
    {
      annotations: { readOnlyHint: false },
      description:
        "Leave a team YOURSELF — the mirror of join_team. Not being on the team reads as not found. Member+.",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "teams:join", async () => {
        await teams.leave(ws, a.id, actor);
        return ok({ left: a.id });
      }),
  );

  server.registerTool(
    "remove_team_member",
    {
      annotations: { readOnlyHint: false },
      description: "Remove a subject from a team's roster. Requires admin.",
      inputSchema: { id: z.string(), subject: z.string() },
    },
    (a) =>
      run(principal, "teams:write", async () => {
        await teams.removeMember(ws, a.id, a.subject, actor);
        return ok({ removed: a.subject });
      }),
  );
}
