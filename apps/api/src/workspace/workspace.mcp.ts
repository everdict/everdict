import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain, run } from "../mcp-context.js";

export function registerWorkspaceTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.workspaceService) {
    const workspaces = deps.workspaceService;
    server.registerTool(
      "list_workspaces",
      { description: "Workspaces I belong to (including role)", inputSchema: {} },
      () => plain(async () => ok(await workspaces.listForSubject(principal.subject))),
    );
    server.registerTool(
      "create_workspace",
      {
        description:
          "Create a new workspace (I become an admin member). name required, id (slug) optional — scope moves to it after creation.",
        inputSchema: {
          name: z.string().describe("display name"),
          id: z.string().optional().describe("workspace id (slug, ^[a-z0-9][a-z0-9-]*$). Derived from name if omitted"),
        },
      },
      ({ name, id }) =>
        plain(async () => ok(await workspaces.create(principal.subject, { name, ...(id ? { id } : {}) }))),
    );
    server.registerTool(
      "get_workspace",
      {
        description: "The active workspace record (id/name/logoUrl/owner/createdAt). admin (settings:read).",
        inputSchema: {},
      },
      () => run(principal, "settings:read", async () => ok(await workspaces.get(ws))),
    );
    server.registerTool(
      "update_workspace",
      {
        description:
          "Update the workspace name/logo (admin, settings:write). The slug (URL) is immutable. Logo is an http(s) URL or data:image base64. Empty string removes the logo.",
        inputSchema: {
          name: z.string().optional().describe("display name (≤80 chars)"),
          logoUrl: z.string().optional().describe("logo image — http(s) URL or data:image base64"),
        },
      },
      ({ name, logoUrl }) =>
        run(principal, "settings:write", async () =>
          ok(
            await workspaces.update(ws, {
              ...(name !== undefined ? { name } : {}),
              ...(logoUrl !== undefined ? { logoUrl } : {}),
            }),
          ),
        ),
    );
    server.registerTool(
      "delete_workspace",
      {
        description:
          "Delete the active workspace (owner/creator only; irreversible). All workspace data — members, runs, settings, etc. — is deleted with it.",
        inputSchema: {},
      },
      () =>
        plain(async () => {
          await workspaces.delete(ws, principal.subject); // the service verifies owner (else FORBIDDEN)
          return ok({ workspace: ws, deleted: true });
        }),
    );
  }
}
