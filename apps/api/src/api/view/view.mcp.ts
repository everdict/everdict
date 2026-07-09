import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UpdateViewInput } from "../../core/view/view-service.js";
import { type McpToolContext, ok, run } from "../mcp-context.js";

export function registerViewTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.viewService) {
    const views = deps.viewService;
    // Saved scorecard-analysis Views — a named AnalysisConfig (opaque). Reuses scorecards:read/run (no new authz).
    server.registerTool(
      "create_view",
      {
        description:
          "Save a scorecard-analysis View — store a named analysis config in the workspace. visibility=private (just me) | workspace (shared). config is the web AnalysisConfig (opaque).",
        inputSchema: {
          name: z.string(),
          config: z.unknown().describe("web AnalysisConfig (recipe). Re-run live, not a snapshot."),
          visibility: z.enum(["private", "workspace"]).optional().describe("default private"),
        },
      },
      (a) =>
        run(principal, "scorecards:run", async () =>
          ok(
            await views.create({
              tenant: ws,
              createdBy: principal.subject,
              name: a.name,
              config: a.config,
              ...(a.visibility !== undefined ? { visibility: a.visibility } : {}),
            }),
          ),
        ),
    );

    server.registerTool(
      "list_views",
      { description: "Analysis Views I can see (workspace-shared + my private)", inputSchema: {} },
      () => run(principal, "scorecards:read", async () => ok(await views.list(ws, principal.subject))),
    );

    server.registerTool(
      "get_view",
      {
        description: "Read one analysis View (others' private / missing → NOT_FOUND)",
        inputSchema: { id: z.string() },
      },
      ({ id }) => run(principal, "scorecards:read", async () => ok(await views.get(ws, id, principal.subject))),
    );

    server.registerTool(
      "update_view",
      {
        description: "Update an analysis View — change name/config/visibility. Owner or workspace admin only.",
        inputSchema: {
          id: z.string(),
          name: z.string().optional(),
          config: z.unknown().optional(),
          visibility: z.enum(["private", "workspace"]).optional(),
        },
      },
      (a) =>
        run(principal, "scorecards:run", async () => {
          const patch: UpdateViewInput = {};
          if (a.name !== undefined) patch.name = a.name;
          if (a.config !== undefined) patch.config = a.config;
          if (a.visibility !== undefined) patch.visibility = a.visibility;
          return ok(
            await views.update(ws, a.id, patch, {
              subject: principal.subject,
              isAdmin: principal.roles.includes("admin"),
            }),
          );
        }),
    );

    server.registerTool(
      "delete_view",
      {
        description: "Delete an analysis View — owner or workspace admin only (other workspaces get NOT_FOUND)",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        run(principal, "scorecards:run", async () => {
          await views.remove(ws, id, {
            subject: principal.subject,
            isAdmin: principal.roles.includes("admin"),
          });
          return ok({ id, deleted: true });
        }),
    );
  }
}
