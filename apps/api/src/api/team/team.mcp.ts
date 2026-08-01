import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
        return ok(
          await Promise.all(rows.map(async (team) => ({ ...team, summary: await teams.summary(ws, team.id) }))),
        );
      }),
  );

  server.registerTool(
    "get_team",
    {
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
      description:
        "Create a team with an immutable identifier prefix (the `key`, e.g. ENG → ENG-1, ENG-2). The first " +
        "team in a workspace is the default whatever you ask for, because an issue filed without a team has " +
        "to land somewhere. Requires admin.",
      inputSchema: {
        key: z.string().min(2).max(6).describe("identifier prefix, e.g. ENG — uppercase, immutable"),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        isDefault: z.boolean().optional().describe("promote to the workspace default, demoting the incumbent"),
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
            ...(a.isDefault !== undefined ? { isDefault: a.isDefault } : {}),
            ...(a.members !== undefined ? { members: a.members } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "update_team",
    {
      description:
        "Rename a team or edit its description. The key cannot change — it is baked into every identifier the " +
        "team has already minted. Requires admin.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
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
            },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "set_default_team",
    {
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
      description: "Add a subject to a team's roster. Requires admin.",
      inputSchema: { id: z.string(), subject: z.string() },
    },
    (a) => run(principal, "teams:write", async () => ok(await teams.addMember(ws, a.id, a.subject, actor))),
  );

  server.registerTool(
    "remove_team_member",
    {
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
