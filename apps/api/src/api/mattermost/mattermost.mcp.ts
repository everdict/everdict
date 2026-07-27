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
          "This workspace's Mattermost integration — host (operator-configured server URL, MATTERMOST_HOST env; absent = unavailable) + config (botTokenSecretName/defaultChannelId, not secret values; absent = not registered).",
        inputSchema: {},
      },
      () => run(principal, "settings:read", async () => ok(await mm.get(ws))),
    );
    server.registerTool(
      "set_workspace_mattermost",
      {
        description:
          "Register/update the Mattermost integration (admin). The server URL is operator env (MATTERMOST_HOST), not passed here. Put the bot token (value) in the SecretStore first and pass its name as botTokenSecretName. The bot token (+ channel) is verified against the live server before saving (a failed connection is an error). defaultChannelId = the completion/regression alert channel.",
        inputSchema: {
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
      ({ botTokenSecretName, defaultChannelId, commandTokenSecretName }) =>
        run(principal, "settings:write", async () =>
          ok({
            config: await mm.set(ws, {
              botTokenSecretName,
              ...(defaultChannelId ? { defaultChannelId } : {}),
              ...(commandTokenSecretName ? { commandTokenSecretName } : {}),
            }),
          }),
        ),
    );
    server.registerTool(
      "probe_workspace_mattermost",
      {
        description:
          "Test a Mattermost bot token (+ optional channel) against the operator server before registering (admin). Returns a classified result (reachable/reason). Put the bot token in the SecretStore first and pass its name.",
        inputSchema: {
          botTokenSecretName: z.string().min(1).describe("SecretStore key name holding the bot access token"),
          defaultChannelId: z.string().min(1).optional().describe("channel to verify accessibility of"),
        },
      },
      ({ botTokenSecretName, defaultChannelId }) =>
        run(principal, "settings:write", async () =>
          ok(await mm.probe(ws, { botTokenSecretName, ...(defaultChannelId ? { defaultChannelId } : {}) })),
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
    server.registerTool(
      "post_mattermost_message",
      {
        description:
          "Post a message to this workspace's configured Mattermost channel (the default channel of the registered bot), as the workspace bot. Use this to notify the team — e.g. a scorecard regression summary or a run result. Requires the workspace to have a registered Mattermost bot + default channel (otherwise an error). member+ (mattermost:post). Returns the channel id the message landed in.",
        inputSchema: {
          message: z.string().min(1).describe("the message text to post (Mattermost Markdown supported)"),
        },
      },
      ({ message }) => run(principal, "mattermost:post", async () => ok(await mm.postMessage(ws, message))),
    );
    server.registerTool(
      "list_mattermost_channels",
      {
        description:
          "List the Mattermost channels this workspace's bot can access (across its teams): id, name, display name, team, type. Requires a registered bot. Use to find a channel id before reading it with get_mattermost_channel_posts.",
        inputSchema: {},
      },
      () => run(principal, "settings:read", async () => ok(await mm.listChannels(ws))),
    );
    server.registerTool(
      "get_mattermost_channel_posts",
      {
        description:
          "Read recent posts in a Mattermost channel (newest first): author user id, message, timestamp. Requires a registered bot with access to the channel. Get the channel id from list_mattermost_channels.",
        inputSchema: {
          channelId: z.string().min(1).describe("the channel id (from list_mattermost_channels)"),
          limit: z.number().int().positive().max(100).optional().describe("max posts to return (default 30, max 100)"),
        },
      },
      ({ channelId, limit }) =>
        run(principal, "settings:read", async () => ok(await mm.getChannelPosts(ws, channelId, limit))),
    );
  }
}
