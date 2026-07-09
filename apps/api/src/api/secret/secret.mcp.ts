import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";

export function registerSecretTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.secretStore) {
    const secrets = deps.secretStore;
    server.registerTool(
      "list_secrets",
      {
        description:
          "List secret names (no values) — shared (workspace) + my personal (user) secrets, each tagged with scope. Values are never returned.",
        inputSchema: {},
      },
      () => run(principal, "secrets:read", async () => ok(await secrets.list(ws, principal.subject))),
    );
    server.registerTool(
      "set_secret",
      {
        description:
          "Set/update a secret (encrypted at rest; the value can't be read back). name is env-style. scope: workspace (shared, default) | user (my personal).",
        inputSchema: {
          name: z.string().describe("env name ^[A-Z_][A-Z0-9_]*$"),
          value: z.string(),
          scope: z.enum(["user", "workspace"]).optional().describe("workspace (shared, default) | user (personal)"),
        },
      },
      ({ name, value, scope }) =>
        run(principal, "secrets:write", async () => {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return fail("BAD_REQUEST: secret name must match ^[A-Z_][A-Z0-9_]*$");
          const owner = scope === "user" ? principal.subject : "";
          await secrets.set(ws, name, value, owner);
          return ok({ workspace: ws, name, scope: scope ?? "workspace", set: true });
        }),
    );
    server.registerTool(
      "delete_secret",
      {
        description: "Delete a secret. scope: workspace (shared, default) | user (my personal).",
        inputSchema: { name: z.string(), scope: z.enum(["user", "workspace"]).optional() },
      },
      ({ name, scope }) =>
        run(principal, "secrets:write", async () => {
          const owner = scope === "user" ? principal.subject : "";
          await secrets.remove(ws, name, owner);
          return ok({ workspace: ws, name, scope: scope ?? "workspace", deleted: true });
        }),
    );
  }
}
