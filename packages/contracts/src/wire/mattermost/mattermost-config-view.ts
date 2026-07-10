import { z } from "zod";

// Workspace Mattermost integration status (MattermostService.MattermostConfigView). No secrets —
// botTokenSecretName/commandTokenSecretName are SecretStore name references, never token values.
export const MattermostConfigViewSchema = z.object({
  host: z.string().describe("In-house Mattermost base URL"),
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

// GET /workspace/mattermost — config is absent when the workspace has no Mattermost registered.
export const MattermostStatusResponseSchema = z.object({
  config: MattermostConfigViewSchema.optional(),
});
export type MattermostStatusResponse = z.infer<typeof MattermostStatusResponseSchema>;

// PUT /workspace/mattermost — the stored config after the upsert.
export const MattermostUpsertResponseSchema = z.object({
  config: MattermostConfigViewSchema,
});
export type MattermostUpsertResponse = z.infer<typeof MattermostUpsertResponseSchema>;
