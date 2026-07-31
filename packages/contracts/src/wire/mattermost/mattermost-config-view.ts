import { z } from "zod";

// One workspace Mattermost connection (MattermostService.MattermostConfigView). No secrets —
// botTokenSecretName/commandTokenSecretName are SecretStore name references, never token values.
// The server URL (host) is an operator env (MATTERMOST_HOST), not part of a connection — it rides at the
// status-response top level, purely as the availability signal (unset = the integration can't be used).
export const MattermostConfigViewSchema = z.object({
  name: z.string().describe("Connection name — the reference/upsert key, unique within the workspace"),
  botTokenSecretName: z.string().describe("SecretStore name of the bot access token (the value itself never leaves)"),
  defaultChannelId: z.string().optional().describe("Default channel for completion/regression notifications"),
  commandTokenSecretName: z
    .string()
    .optional()
    .describe("SecretStore name of the inbound (slash-command/button) verification token — setting it enables inbound"),
  commandUrl: z
    .string()
    .optional()
    .describe(
      "Inbound slash-command URL to register on the Mattermost side (present when the API public URL is known)",
    ),
  actionUrl: z
    .string()
    .optional()
    .describe(
      "Inbound interactive-action URL to register on the Mattermost side (present when the API public URL is known)",
    ),
});
export type MattermostConfigView = z.infer<typeof MattermostConfigViewSchema>;

// GET /workspace/mattermost — host is the operator-configured server URL (absent = operator hasn't set
// MATTERMOST_HOST → integration unavailable). connections is this workspace's registered bot+channel pairs
// (empty when nothing is registered yet); completion/regression notifications fan out to every one with a channel.
export const MattermostStatusResponseSchema = z.object({
  host: z.string().optional().describe("Operator-configured Mattermost server URL (MATTERMOST_HOST env)"),
  connections: z
    .array(MattermostConfigViewSchema)
    .describe("Registered connections (bot + channel), one per team/purpose"),
});
export type MattermostStatusResponse = z.infer<typeof MattermostStatusResponseSchema>;

// PUT /workspace/mattermost — the stored connection after a verified upsert.
export const MattermostUpsertResponseSchema = z.object({
  config: MattermostConfigViewSchema,
});
export type MattermostUpsertResponse = z.infer<typeof MattermostUpsertResponseSchema>;
