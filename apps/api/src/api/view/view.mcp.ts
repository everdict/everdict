import type { UpdateViewInput } from "@everdict/application-control";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fsActorFor } from "../fs/fs-actor.js";
import { type McpToolContext, ok, run } from "../mcp-context.js";

export function registerViewTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.viewService) {
    const views = deps.viewService;
    // Saved scorecard-analysis Views — a named AnalysisConfig (opaque). Reuses scorecards:read/run (no new authz).
    server.registerTool(
      "create_view",
      {
        annotations: { readOnlyHint: false },
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
      {
        annotations: { readOnlyHint: true },
        description: "Analysis Views I can see (workspace-shared + my private)",
        inputSchema: {},
      },
      () => run(principal, "scorecards:read", async () => ok(await views.list(ws, principal.subject))),
    );

    server.registerTool(
      "get_view",
      {
        annotations: { readOnlyHint: true },
        description: "Read one analysis View (others' private / missing → NOT_FOUND)",
        inputSchema: { id: z.string() },
      },
      ({ id }) => run(principal, "scorecards:read", async () => ok(await views.get(ws, id, principal.subject))),
    );

    server.registerTool(
      "update_view",
      {
        annotations: { readOnlyHint: false },
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
        annotations: { readOnlyHint: false },
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

  if (deps.viewSnapshotService) {
    const snapshots = deps.viewSnapshotService;
    server.registerTool(
      "capture_view_snapshot",
      {
        annotations: { readOnlyHint: false },
        description:
          "Capture a saved View onto the workspace filesystem — compute its analysis now and write it, with the " +
          "config that produced it, to views/<id>/<capturedAt>.json. A View re-runs live and remembers nothing; " +
          "captures accumulate the record of what it said. Read them back with list_files/get_file on views/<id>.",
        inputSchema: { id: z.string().describe("saved View id") },
      },
      ({ id }) =>
        run(principal, "scorecards:run", async () =>
          ok(await snapshots.capture({ tenant: ws, viewId: id, actor: fsActorFor(principal, ctx.agent) })),
        ),
    );
  }
}
