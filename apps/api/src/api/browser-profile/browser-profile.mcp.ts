import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain } from "../mcp-context.js";

// Saved browser profiles over MCP — BFF↔MCP parity with browser-profile.routes.ts. Personal / self-scoped
// (owner = principal.subject): no role gate; the service enforces owner-only.
export function registerBrowserProfileTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal } = ctx;
  if (!deps.browserProfileService) return;
  const profiles = deps.browserProfileService;

  server.registerTool(
    "create_browser_profile",
    {
      description: "Create a saved authenticated browser profile (a reusable login). Personal / self-scoped.",
      inputSchema: {
        name: z.string().min(1).describe("Profile name"),
        cookieDomains: z.array(z.string()).optional().describe("Domains this profile logs into (optional)"),
      },
    },
    ({ name, cookieDomains }) =>
      plain(async () =>
        ok(
          await profiles.create({
            tenant: principal.workspace,
            createdBy: principal.subject,
            name,
            ...(cookieDomains ? { cookieDomains } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_browser_profiles",
    { description: "List my saved browser profiles (self-scoped).", inputSchema: {} },
    () => plain(async () => ok(await profiles.list(principal.workspace, principal.subject))),
  );

  server.registerTool(
    "get_browser_profile",
    { description: "Get one of my saved browser profiles by id.", inputSchema: { id: z.string() } },
    ({ id }) => plain(async () => ok(await profiles.get(principal.workspace, id, principal.subject))),
  );

  server.registerTool(
    "update_browser_profile",
    {
      description: "Rename a browser profile or update its declared cookie domains. Owner-only.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).optional(),
        cookieDomains: z.array(z.string()).optional(),
      },
    },
    ({ id, name, cookieDomains }) =>
      plain(async () =>
        ok(
          await profiles.update(
            principal.workspace,
            id,
            { ...(name !== undefined ? { name } : {}), ...(cookieDomains !== undefined ? { cookieDomains } : {}) },
            principal.subject,
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_browser_profile",
    { description: "Delete a saved browser profile. Owner-only.", inputSchema: { id: z.string() } },
    ({ id }) =>
      plain(async () => {
        await profiles.remove(principal.workspace, id, principal.subject);
        return ok({ ok: true });
      }),
  );
}
