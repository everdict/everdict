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
          // Workspace secrets feed cached runtime backends (secretEnv baked at build) — drop the cache (route parity).
          if (owner === "") deps.invalidateTenantBackends?.(ws);
          return ok({ workspace: ws, name, scope: scope ?? "workspace", set: true });
        }),
    );
    server.registerTool(
      "set_offline_token",
      {
        description:
          "Register/replace an offline-token secret (kind=offline_token): a long-lived OAuth refresh token the control plane exchanges for a short-lived access token on demand. On registration it performs one refresh-token grant to validate the token + compute the first access-token expiry; thereafter any reference to this secret name resolves to a freshly-minted access token (the refresh token never leaves the control plane). name is env-style. scope: workspace (shared, default) | user (my personal).",
        inputSchema: {
          name: z.string().describe("env name ^[A-Z_][A-Z0-9_]*$"),
          tokenUrl: z.string().describe("OAuth token endpoint URL (the refresh-token grant is POSTed here)"),
          clientId: z.string(),
          clientSecret: z.string().optional().describe("OAuth client secret — omit for public clients"),
          refreshToken: z.string().describe("the long-lived refresh token (the offline token itself)"),
          oauthScope: z.string().optional().describe("optional OAuth scope to request on refresh"),
          scope: z
            .enum(["user", "workspace"])
            .optional()
            .describe("secret scope: workspace (shared, default) | user (personal)"),
        },
      },
      ({ name, tokenUrl, clientId, clientSecret, refreshToken, oauthScope, scope }) =>
        run(principal, "secrets:write", async () => {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return fail("BAD_REQUEST: secret name must match ^[A-Z_][A-Z0-9_]*$");
          const owner = scope === "user" ? principal.subject : "";
          const meta = await secrets.setOfflineToken(
            ws,
            name,
            {
              tokenUrl,
              clientId,
              ...(clientSecret ? { clientSecret } : {}),
              refreshToken,
              ...(oauthScope ? { scope: oauthScope } : {}),
            },
            owner,
          );
          if (owner === "") deps.invalidateTenantBackends?.(ws);
          return ok({ workspace: ws, ...meta });
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
          if (owner === "") deps.invalidateTenantBackends?.(ws);
          return ok({ workspace: ws, name, scope: scope ?? "workspace", deleted: true });
        }),
    );
  }

  if (deps.secretUsageService) {
    const usage = deps.secretUsageService;
    server.registerTool(
      "list_secret_usage",
      {
        description:
          "List workspace (shared) secrets, each with the live sites that reference it by name — harness env/trace, runtime auth, model api-key, and settings integrations. Computed fresh (a removed reference disappears); refs=[] means the secret is referenced nowhere (orphan). Admin-only (secrets:read). Values are never returned.",
        inputSchema: {},
      },
      () => run(principal, "secrets:read", async () => ok(await usage.list(ws))),
    );
  }
}
