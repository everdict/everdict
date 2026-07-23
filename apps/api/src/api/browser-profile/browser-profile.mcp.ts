import { BrowserProfileVisibilitySchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain } from "../mcp-context.js";

// Saved browser profiles over MCP — BFF↔MCP parity with browser-profile.routes.ts. Dual-scoped (`private` personal /
// `workspace` shared): list returns the caller's visible set (workspace + own private); writes (update/delete +
// capture/restore) run the service's per-visibility gate (createdBy = principal.subject, admin =
// principal.roles.includes("admin")).
export function registerBrowserProfileTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal } = ctx;
  if (!deps.browserProfileService) return;
  const profiles = deps.browserProfileService;

  server.registerTool(
    "create_browser_profile",
    {
      description:
        "Create a saved authenticated browser profile (a reusable login). Scope with `visibility`: 'private' " +
        "(personal, creator-only — the default) or 'workspace' (shared; managed by the creator or a workspace admin).",
      inputSchema: {
        name: z.string().min(1).describe("Profile name"),
        visibility: BrowserProfileVisibilitySchema.optional().describe(
          "'private' (personal, default) or 'workspace' (shared)",
        ),
        cookieDomains: z.array(z.string()).optional().describe("Domains this profile logs into (optional)"),
        country: z
          .string()
          .min(1)
          .optional()
          .describe("Egress-proxy country the login session used (omitted = direct)"),
      },
    },
    ({ name, visibility, cookieDomains, country }) =>
      plain(async () =>
        ok(
          await profiles.create({
            tenant: principal.workspace,
            createdBy: principal.subject,
            name,
            ...(visibility ? { visibility } : {}),
            ...(cookieDomains ? { cookieDomains } : {}),
            ...(country ? { country } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_browser_profiles",
    {
      description: "List the browser profiles I can see — every shared workspace profile plus my own private ones.",
      inputSchema: {},
    },
    () => plain(async () => ok(await profiles.list(principal.workspace, principal.subject))),
  );

  server.registerTool(
    "get_browser_profile",
    {
      description: "Get a browser profile by id (a shared workspace profile, or my own private one).",
      inputSchema: { id: z.string() },
    },
    ({ id }) => plain(async () => ok(await profiles.get(principal.workspace, id, principal.subject))),
  );

  server.registerTool(
    "update_browser_profile",
    {
      description:
        "Rename a browser profile, update its declared cookie domains, or change its scope (share private→workspace " +
        "/ make workspace→private). Creator-or-admin only (a private profile: creator only).",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).optional(),
        cookieDomains: z.array(z.string()).optional(),
        visibility: BrowserProfileVisibilitySchema.optional().describe(
          "Change scope: 'private' (personal) or 'workspace' (shared)",
        ),
      },
    },
    ({ id, name, cookieDomains, visibility }) =>
      plain(async () =>
        ok(
          await profiles.update(
            principal.workspace,
            id,
            {
              ...(name !== undefined ? { name } : {}),
              ...(cookieDomains !== undefined ? { cookieDomains } : {}),
              ...(visibility !== undefined ? { visibility } : {}),
            },
            { subject: principal.subject, isAdmin: principal.roles.includes("admin") },
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_browser_profile",
    { description: "Delete a saved browser profile. Creator-or-admin only.", inputSchema: { id: z.string() } },
    ({ id }) =>
      plain(async () => {
        await profiles.remove(principal.workspace, id, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        });
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
          "stores the login encrypted so it can be reused in browser evals. Creator-or-admin only (the session is " +
          "always my own).",
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
              isAdmin: principal.roles.includes("admin"),
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
          "control plane). Creator-or-admin only (the session is always my own).",
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
              isAdmin: principal.roles.includes("admin"),
            }),
          ),
        ),
    );
  }
}
