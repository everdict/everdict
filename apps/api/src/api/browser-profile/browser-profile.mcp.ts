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
        country: z
          .string()
          .min(1)
          .optional()
          .describe("Egress-proxy country the login session used (omitted = direct)"),
      },
    },
    ({ name, cookieDomains, country }) =>
      plain(async () =>
        ok(
          await profiles.create({
            tenant: principal.workspace,
            createdBy: principal.subject,
            name,
            ...(cookieDomains ? { cookieDomains } : {}),
            ...(country ? { country } : {}),
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

  if (deps.browserProfileCaptureService) {
    const capture = deps.browserProfileCaptureService;
    server.registerTool(
      "capture_browser_profile",
      {
        description:
          "Capture the cookies of my active interactive browser session into a profile (browser-profiles S3) — " +
          "stores the login encrypted so it can be reused in browser evals. Owner-only.",
        inputSchema: {
          id: z.string().describe("Browser profile id"),
          sessionId: z.string().describe("The interactive browser session to capture cookies from"),
          cookies: z
            .array(z.object({ domain: z.string().min(1), name: z.string().min(1) }))
            .min(1)
            .optional()
            .describe(
              "Only save these cookies, addressed as the state preview reports them (domain without the " +
                "leading dot + name). Omitted = save every cookie the session holds.",
            ),
        },
      },
      ({ id, sessionId, cookies }) =>
        plain(async () =>
          ok(
            await capture.captureInto({
              tenant: principal.workspace,
              profileId: id,
              sessionId,
              subject: principal.subject,
              ...(cookies ? { cookies } : {}),
            }),
          ),
        ),
    );

    server.registerTool(
      "restore_browser_profile",
      {
        description:
          "Warm re-login — seed a profile's saved cookies into my active interactive browser session so re-logging " +
          "in starts from the prior state instead of a blank browser (browser-profiles). A no-op for a profile " +
          "with no login captured yet. Returns the domains the profile carries (cookie values never leave the " +
          "control plane). Owner-only.",
        inputSchema: {
          id: z.string().describe("Browser profile id"),
          sessionId: z.string().describe("The interactive browser session to seed the saved login into"),
        },
      },
      ({ id, sessionId }) =>
        plain(async () =>
          ok(
            await capture.restoreInto({
              tenant: principal.workspace,
              profileId: id,
              sessionId,
              subject: principal.subject,
            }),
          ),
        ),
    );
  }
}
