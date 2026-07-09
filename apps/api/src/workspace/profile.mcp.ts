import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain } from "../mcp-context.js";

export function registerProfileTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal } = ctx;

  if (deps.profileService) {
    const profiles = deps.profileService;
    server.registerTool(
      "get_profile",
      {
        description:
          "Read my profile (name/username/avatar). Empty object if none. email is SSO (read-only), seen via whoami/me.",
        inputSchema: {},
      },
      () => plain(async () => ok((await profiles.get(principal.subject)) ?? {})),
    );
    server.registerTool(
      "update_profile",
      {
        description:
          "Update my profile (self-serve, role-agnostic). Only provided fields change, an empty string clears that field. email is SSO and can't be edited.",
        inputSchema: {
          name: z.string().optional().describe("display name (≤80 chars)"),
          username: z.string().optional().describe("username (alphanumeric/_/-, 2–39 chars)"),
          avatarUrl: z.string().optional().describe("avatar image — http(s) URL or data:image base64"),
        },
      },
      ({ name, username, avatarUrl }) =>
        plain(async () =>
          ok(
            await profiles.update(principal.subject, {
              ...(name !== undefined ? { name } : {}),
              ...(username !== undefined ? { username } : {}),
              ...(avatarUrl !== undefined ? { avatarUrl } : {}),
            }),
          ),
        ),
    );
  }
}
