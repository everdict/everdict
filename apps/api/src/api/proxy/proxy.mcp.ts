import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain, run } from "../mcp-context.js";

// Workspace egress proxies over MCP — BFF↔MCP parity with proxy.routes.ts. list = workspace read; register/remove =
// admin (settings:write).
export function registerProxyTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal } = ctx;
  if (!deps.proxyService) return;
  const proxies = deps.proxyService;

  server.registerTool(
    "list_proxies",
    { description: "List the workspace's BYO egress proxies (per-country; secrets redacted).", inputSchema: {} },
    () => plain(async () => ok({ proxies: await proxies.list(principal.workspace) })),
  );

  server.registerTool(
    "register_proxy",
    {
      description: "Register or update a BYO egress proxy for a country (admin). authSecretName is a SecretStore key.",
      inputSchema: {
        name: z.string().min(1),
        country: z.string().min(1),
        url: z.string().min(1),
        authSecretName: z.string().min(1).optional(),
      },
    },
    ({ name, country, url, authSecretName }) =>
      run(principal, "settings:write", async () =>
        ok(
          await proxies.upsert(principal.workspace, {
            name,
            country,
            url,
            ...(authSecretName ? { authSecretName } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "remove_proxy",
    { description: "Remove a workspace egress proxy by name (admin).", inputSchema: { name: z.string().min(1) } },
    ({ name }) =>
      run(principal, "settings:write", async () => {
        await proxies.remove(principal.workspace, name);
        return ok({ ok: true });
      }),
  );
}
