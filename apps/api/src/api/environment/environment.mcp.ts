import { setVersionTags } from "@everdict/application-control";
import { EnvironmentSpecSchema } from "@everdict/contracts";
import { ownedByVisibleTeam } from "@everdict/domain";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertEntityVisible, visibleTeamsFor } from "../../common/team-scope.js";
import { type McpToolContext, fail, ok, plain, run, runForTeam } from "../mcp-context.js";

// Environment MCP tools — the MCP twin of environment.routes.ts (BFF↔MCP parity is structural).
export function registerEnvironmentTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.environmentRegistry) return;
  const environments = deps.environmentRegistry;

  server.registerTool(
    "list_environments",
    {
      annotations: { readOnlyHint: true },
      description:
        "The worlds a case can be posed against (Environment: owned + _shared) — the seed repository, browser fixture, prompt context or desktop a case ACTS ON",
      inputSchema: {},
    },
    () =>
      run(principal, "datasets:read", async () => {
        const seen = await visibleTeamsFor(deps, principal);
        return ok((await environments.list(ws)).filter((row) => ownedByVisibleTeam(row, seen)));
      }),
  );

  server.registerTool(
    "get_environment",
    {
      annotations: { readOnlyHint: true },
      description: "A full EnvironmentSpec. version defaults to latest. Other workspaces get NOT_FOUND",
      inputSchema: { id: z.string(), version: z.string().optional() },
    },
    ({ id, version }) =>
      run(principal, "datasets:read", async () => {
        await assertEntityVisible(deps, principal, environments, ws, id, "environment");
        return ok(await environments.get(ws, id, version ?? "latest"));
      }),
  );

  server.registerTool(
    "create_environment",
    {
      description:
        'Register an EnvironmentSpec (JSON string) as owned by this workspace (immutable; CONFLICT on collision). A case names it with env: { kind: "ref", id, version }, and the version a batch resolves is sealed on its manifest',
      inputSchema: {
        environment: z.string().describe("EnvironmentSpec JSON"),
        team: z
          .string()
          .optional()
          .describe(
            'the owning team — id or key ("ENG"). A team you are not on is refused. Absent: your own team, else the workspace default',
          ),
      },
    },
    ({ environment, team }) =>
      // Owner resolved and AUTHORIZED before the write (the HTTP twin's teamForNew + gate pair).
      runForTeam(ctx, "datasets:write", team, async (teamId) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(environment);
        } catch {
          return fail("BAD_REQUEST: not a valid EnvironmentSpec JSON.");
        }
        const result = EnvironmentSpecSchema.safeParse(parsed);
        if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
        // …and the creator stamp the HTTP twin writes (HTTP parity).
        await environments.register(ws, result.data, principal.subject, teamId);
        return ok({ workspace: ws, id: result.data.id, version: result.data.version, ...(teamId ? { teamId } : {}) });
      }),
  );

  server.registerTool(
    "set_environment_version_tags",
    {
      description:
        "Replace all tags on an environment version (empty array = remove all) — free-form labels outside the spec. Gate: datasets:write. _shared / other-workspace versions get NOT_FOUND.",
      inputSchema: {
        id: z.string(),
        version: z.string().describe("exact version (latest not allowed)"),
        tags: z.array(z.string()).describe("all tags for this version (≤60 chars each, ≤20 per version; replaces)"),
      },
    },
    ({ id, version, tags }) =>
      plain(async () => ok(await setVersionTags(environments, principal, "datasets:write", id, version, tags))),
  );
}
