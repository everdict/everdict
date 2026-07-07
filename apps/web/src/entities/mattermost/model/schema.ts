import { z } from 'zod'

// Client mirror of the control plane /workspace/mattermost response — workspace-owned Mattermost integration.
// No secrets: botTokenSecretName is a SecretStore name reference, not the value. The bot token value never reaches the browser.
export const mattermostConfigSchema = z.object({
  host: z.string(),
  botTokenSecretName: z.string(),
  defaultChannelId: z.string().optional(),
  // inbound (slash command/button) verification token name + the inbound URL an admin registers in MM (only when configured).
  commandTokenSecretName: z.string().optional(),
  commandUrl: z.string().optional(),
  actionUrl: z.string().optional(),
})
export type MattermostConfig = z.infer<typeof mattermostConfigSchema>

// GET /workspace/mattermost → { config? }; PUT → { config }.
export const mattermostResponseSchema = z.object({ config: mattermostConfigSchema.optional() })
export type MattermostResponse = z.infer<typeof mattermostResponseSchema>
