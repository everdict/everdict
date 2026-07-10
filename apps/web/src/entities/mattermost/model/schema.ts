import type { MattermostConfigView, MattermostStatusResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
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

// GET /workspace/mattermost → { config? }; PUT → { config }.
export const mattermostResponseSchema = z.object({ config: mattermostConfigSchema.optional() })

// Drift guards — both are identical-shape (the web models every wire field and no extra), so the guards are
// bidirectional: a renamed/dropped/added field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebMattermostConfig = z.infer<typeof mattermostConfigSchema>
type WebMattermostResponse = z.infer<typeof mattermostResponseSchema>
type _configFwd = AssertAssignable<WebMattermostConfig, MattermostConfigView>
type _configBack = AssertAssignable<MattermostConfigView, WebMattermostConfig>
type _responseFwd = AssertAssignable<WebMattermostResponse, MattermostStatusResponse>
type _responseBack = AssertAssignable<MattermostStatusResponse, WebMattermostResponse>

// Exported names alias the contract types (consumers untouched: same MattermostConfig / MattermostResponse).
export type MattermostConfig = MattermostConfigView
export type MattermostResponse = MattermostStatusResponse

export type __mattermostDriftGuard = [_configFwd, _configBack, _responseFwd, _responseBack]
