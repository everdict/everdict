import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Mattermost MCP tools — the MCP twin of mattermost.routes.ts.
export function registerMattermostTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  // Workspace-owned Mattermost integration (replaces personal-connection notifications) — post completion/regression alerts to a channel with a bot token. settings:read/write.
  if (deps.mattermostService) {
    const mm = deps.mattermostService;
    server.registerTool(
      "get_workspace_mattermost",
      {
        description:
          "This workspace's Mattermost integration settings — host/botTokenSecretName/defaultChannelId (not secret values). If unset, no config.",
        inputSchema: {},
      },
      () =>
        run(principal, "settings:read", async () => {
          const config = await mm.get(ws);
          return ok({ ...(config ? { config } : {}) });
        }),
    );
    server.registerTool(
      "set_workspace_mattermost",
      {
        description:
          "Register/update the Mattermost integration (admin). Put the bot token (value) in the SecretStore first and pass its name as botTokenSecretName. defaultChannelId = the completion/regression alert channel.",
        inputSchema: {
          host: z.string().url().describe("internal Mattermost base URL"),
          botTokenSecretName: z.string().min(1).describe("SecretStore key name holding the bot access token"),
          defaultChannelId: z
            .string()
            .min(1)
            .optional()
            .describe("default channel id for completion/regression alerts"),
          commandTokenSecretName: z
            .string()
            .min(1)
            .optional()
            .describe(
              "SecretStore name of the inbound (slash-command/button) verification token — set it to enable the /everdict command",
            ),
        },
      },
      ({ host, botTokenSecretName, defaultChannelId, commandTokenSecretName }) =>
        run(principal, "settings:write", async () =>
          ok({
            config: await mm.set(ws, {
              host,
              botTokenSecretName,
              ...(defaultChannelId ? { defaultChannelId } : {}),
              ...(commandTokenSecretName ? { commandTokenSecretName } : {}),
            }),
          }),
        ),
    );
    server.registerTool(
      "remove_workspace_mattermost",
      {
        description:
          "Unregister the Mattermost integration (admin). Completion/regression alerts are no longer posted afterward.",
        inputSchema: {},
      },
      () =>
        run(principal, "settings:write", async () => {
          await mm.clear(ws);
          return ok({ ok: true });
        }),
    );
  }
}
