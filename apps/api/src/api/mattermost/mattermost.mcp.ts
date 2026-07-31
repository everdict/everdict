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
          "This workspace's Mattermost connections — host (operator-configured server URL, MATTERMOST_HOST env; absent = unavailable) + connections[] (name/botTokenSecretName/defaultChannelId, not secret values; empty = nothing registered). Completion/regression alerts go to every connection that has a channel.",
        inputSchema: {},
      },
      () => run(principal, "settings:read", async () => ok(await mm.get(ws))),
    );
    server.registerTool(
      "set_workspace_mattermost",
      {
        description:
          "Register/update one Mattermost connection (admin, upsert by name — a workspace can register several, one bot+channel per team/purpose). The server URL is operator env (MATTERMOST_HOST), not passed here. Put the bot token (value) in the SecretStore first and pass its name as botTokenSecretName. The bot token (+ channel) is verified against the live server before saving (a failed connection is an error). defaultChannelId = the completion/regression alert channel of THIS connection.",
        inputSchema: {
          name: z.string().min(1).optional().describe("connection name (upsert key; omitted = 'default')"),
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
      ({ name, botTokenSecretName, defaultChannelId, commandTokenSecretName }) =>
        run(principal, "settings:write", async () =>
          ok({
            config: await mm.set(ws, {
              ...(name ? { name } : {}),
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
          "Remove one Mattermost connection by name (admin). Its channel stops receiving completion/regression alerts; the workspace's other connections are untouched.",
        inputSchema: { name: z.string().min(1).describe("name of the connection to remove") },
      },
      ({ name }) =>
        run(principal, "settings:write", async () => {
          await mm.remove(ws, name);
          return ok({ ok: true });
        }),
    );
    server.registerTool(
      "post_mattermost_message",
      {
        description:
          "Post a message to a workspace Mattermost channel (a connection's configured channel), as that connection's bot. Use this to notify the team — e.g. a scorecard regression summary or a run result. connection picks which registered connection to post through (omit for the first one; get the names from get_workspace_mattermost). Requires a registered bot + a channel on it (otherwise an error). member+ (mattermost:post). Returns the connection + channel id the message landed in.",
        inputSchema: {
          message: z.string().min(1).describe("the message text to post (Mattermost Markdown supported)"),
          connection: z.string().min(1).optional().describe("connection name (omitted = the first registered one)"),
        },
      },
      ({ message, connection }) =>
        run(principal, "mattermost:post", async () => ok(await mm.postMessage(ws, message, connection))),
    );
    server.registerTool(
      "list_mattermost_channels",
      {
        description:
          "List the Mattermost channels a workspace bot can access (across its teams): id, name, display name, team, type. Requires a registered bot; connection picks which one (omitted = the first). Use to find a channel id before reading it with get_mattermost_channel_posts.",
        inputSchema: {
          connection: z.string().min(1).optional().describe("connection name (omitted = the first registered one)"),
        },
      },
      ({ connection }) => run(principal, "settings:read", async () => ok(await mm.listChannels(ws, connection))),
    );
    server.registerTool(
      "get_mattermost_channel_posts",
      {
        description:
          "Read recent posts in a Mattermost channel (newest first): author user id, message, timestamp. Requires a registered bot with access to the channel; connection picks which one (omitted = the first). Get the channel id from list_mattermost_channels.",
        inputSchema: {
          channelId: z.string().min(1).describe("the channel id (from list_mattermost_channels)"),
          limit: z.number().int().positive().max(100).optional().describe("max posts to return (default 30, max 100)"),
          connection: z.string().min(1).optional().describe("connection name (omitted = the first registered one)"),
        },
      },
      ({ channelId, limit, connection }) =>
        run(principal, "settings:read", async () => ok(await mm.getChannelPosts(ws, channelId, limit, connection))),
    );
  }
}
