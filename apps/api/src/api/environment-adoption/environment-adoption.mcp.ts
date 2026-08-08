import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Environment-image adoption MCP tools — the MCP twin of environment-adoption.routes.ts. list_/get_ prefixes are
// auto-exposed to the agent as reads; adopt/unadopt/verify are settings:write.
export function registerEnvironmentAdoptionTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.environmentAdoptionService) return;
  const service = deps.environmentAdoptionService;

  server.registerTool(
    "list_adopted_environments",
    {
      annotations: { readOnlyHint: true },
      description:
        "This workspace's adopted (imported) environment images — [{source,id,version,name,image,benchmark?,imageClass?,available,verify?}]. verify.pullable = whether this workspace can actually pull the image.",
      inputSchema: {},
    },
    () =>
      run(principal, "capabilities:read", async () => ok({ environments: await service.list(ws, principal.subject) })),
  );

  server.registerTool(
    "adopt_environment",
    {
      annotations: { readOnlyHint: false },
      description:
        "Import an environment image capability into this workspace (pins the version) and verify pull-usability (warn-not-block). Re-adopting the same (source,id) replaces the pin. Returns the adopted entry with its verify status.",
      inputSchema: {
        source: z.string().min(1).describe("the publishing (owner) workspace of the environment capability"),
        id: z.string().min(1),
        version: z.string().min(1).describe("the immutable version to pin"),
      },
    },
    (input) => run(principal, "settings:write", async () => ok(await service.adopt(ws, principal.subject, input))),
  );

  server.registerTool(
    "verify_adopted_environment",
    {
      annotations: { readOnlyHint: false },
      description:
        "Re-run the pull-usability check for one adopted environment and persist the fresh snapshot. Returns the updated entry.",
      inputSchema: { source: z.string().min(1), id: z.string().min(1) },
    },
    ({ source, id }) =>
      run(principal, "settings:write", async () => ok(await service.reverify(ws, principal.subject, source, id))),
  );

  server.registerTool(
    "unadopt_environment",
    {
      annotations: { readOnlyHint: false },
      description: "Remove an environment image from this workspace's inventory (by source + id).",
      inputSchema: { source: z.string().min(1), id: z.string().min(1) },
    },
    ({ source, id }) =>
      run(principal, "settings:write", async () => {
        await service.unadopt(ws, source, id);
        return ok({ ok: true });
      }),
  );
}
