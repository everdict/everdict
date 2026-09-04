import { setVersionTags } from "@everdict/application-control";
import { EnvironmentSpecSchema } from "@everdict/contracts";
import { imageWarnings } from "@everdict/domain";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, plain, run } from "../mcp-context.js";

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
        return ok(await environments.list(ws));
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
      },
    },
    ({ environment }) =>
      run(ctx.principal, "datasets:write", async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(environment);
        } catch {
          return fail("BAD_REQUEST: not a valid EnvironmentSpec JSON.");
        }
        const result = EnvironmentSpecSchema.safeParse(parsed);
        if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
        // …and the creator stamp the HTTP twin writes (HTTP parity).
        await environments.register(ws, result.data, principal.subject);
        // HTTP parity: the same image advice its twin gives.
        const warnings =
          result.data.image !== undefined
            ? imageWarnings([result.data.image], await deps.imageRegistryService?.coordinates(ws))
            : [];
        return ok({
          workspace: ws,
          id: result.data.id,
          version: result.data.version,
          ...(warnings.length > 0 ? { imageWarnings: warnings } : {}),
        });
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
