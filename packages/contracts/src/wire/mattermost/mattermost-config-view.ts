import { z } from "zod";

// Workspace Mattermost integration status (MattermostService.MattermostConfigView). No secrets —
// botTokenSecretName/commandTokenSecretName are SecretStore name references, never token values.
// The server URL (host) is an operator env (MATTERMOST_HOST), not part of the per-workspace config — it
// rides at the status-response top level so the register form can show it before a workspace registers.
export const MattermostConfigViewSchema = z.object({
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
// MATTERMOST_HOST → integration unavailable). config is absent when the workspace hasn't registered a bot yet.
export const MattermostStatusResponseSchema = z.object({
  host: z.string().optional().describe("Operator-configured Mattermost server URL (MATTERMOST_HOST env)"),
  config: MattermostConfigViewSchema.optional(),
});
export type MattermostStatusResponse = z.infer<typeof MattermostStatusResponseSchema>;

// PUT /workspace/mattermost — the stored config after a verified upsert.
export const MattermostUpsertResponseSchema = z.object({
  config: MattermostConfigViewSchema,
});
export type MattermostUpsertResponse = z.infer<typeof MattermostUpsertResponseSchema>;
