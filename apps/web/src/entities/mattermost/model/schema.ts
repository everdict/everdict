import type {
  MattermostConfigView,
  MattermostProbeResult,
  MattermostStatusResponse,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the control plane /workspace/mattermost response — workspace-owned Mattermost connections
// (a workspace registers one bot + channel per team/purpose; completion/regression alerts go to every one that
// has a channel). No secrets: botTokenSecretName is a SecretStore name reference, not the value. The server URL
// (host) is an operator env (MATTERMOST_HOST) — it rides at the status top level purely as the availability
// signal (the UI never shows it; a workspace never inputs it).
export const mattermostConfigSchema = z.object({
  name: z.string(),
  botTokenSecretName: z.string(),
  defaultChannelId: z.string().optional(),
  // inbound (slash command/button) verification token name + the inbound URL an admin registers in MM (only when configured).
  commandTokenSecretName: z.string().optional(),
  commandUrl: z.string().optional(),
  actionUrl: z.string().optional(),
})

// GET /workspace/mattermost → { host? (operator env server URL), connections[] (the workspace's registrations) }.
export const mattermostResponseSchema = z.object({
  host: z.string().optional(),
  connections: z.array(mattermostConfigSchema),
})

// POST /workspace/mattermost/probe → the connection-test outcome (classified; reachable gates Save).
export const mattermostProbeResultSchema = z.object({
  reachable: z.boolean(),
  detail: z.string(),
  reason: z.enum(['auth', 'channel', 'unreachable', 'error']).optional(),
  botUsername: z.string().optional(),
  channelName: z.string().optional(),
})

// Drift guards — identical-shape (the web models every wire field and no extra), so bidirectional: a
// renamed/dropped/added field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebMattermostConfig = z.infer<typeof mattermostConfigSchema>
type WebMattermostResponse = z.infer<typeof mattermostResponseSchema>
type WebMattermostProbeResult = z.infer<typeof mattermostProbeResultSchema>
type _configFwd = AssertAssignable<WebMattermostConfig, MattermostConfigView>
type _configBack = AssertAssignable<MattermostConfigView, WebMattermostConfig>
type _responseFwd = AssertAssignable<WebMattermostResponse, MattermostStatusResponse>
type _responseBack = AssertAssignable<MattermostStatusResponse, WebMattermostResponse>
type _probeFwd = AssertAssignable<WebMattermostProbeResult, MattermostProbeResult>
type _probeBack = AssertAssignable<MattermostProbeResult, WebMattermostProbeResult>

// Exported names alias the contract types (consumers untouched: same MattermostConfig / MattermostResponse).
export type MattermostConfig = MattermostConfigView
export type MattermostResponse = MattermostStatusResponse
export type MattermostProbe = MattermostProbeResult

export type __mattermostDriftGuard = [
  _configFwd,
  _configBack,
  _responseFwd,
  _responseBack,
  _probeFwd,
  _probeBack,
]
