// Outbound Mattermost port (re-architecture P2d) — the use-case layer decides WHEN to notify and
// WHAT the message says; the wire protocol (endpoint path, auth header, body shape) is the adapter's
// (apps/api infrastructure/mattermost). `post` throws a remapped AppError (UpstreamError) on a transport
// or non-2xx failure: fire-and-forget callers (completion notifications) swallow it in their own try/catch,
// while the agent's post_mattermost_message tool lets it propagate so the user learns the post failed.
export interface MattermostPost {
  channelId: string;
  message: string;
  attachments?: unknown[]; // message-attachment payloads (e.g. the interactive Rerun button) — assembled by the use-case, shipped verbatim
}

// Connection-test outcome for a Mattermost bot token (+ optional channel). Structurally mirrors the wire
// MattermostProbeResult (kept in sync by convention, same as MattermostConfigView ↔ its wire schema). Never
// thrown — returned classified so the caller (strict save / explicit probe) renders the reason.
export interface MattermostProbeResult {
  reachable: boolean;
  detail: string;
  reason?: "auth" | "channel" | "unreachable" | "error";
  botUsername?: string;
  channelName?: string;
}

export interface MattermostClient {
  post(host: string, botToken: string, post: MattermostPost): Promise<void>;
  // Connection test run before registration (strict on save + the explicit /probe): the bot token authenticates
  // against {host}/api/v4/users/me and, when a channelId is given, {host}/api/v4/channels/{id} is checked. Never
  // throws for reachability — returns a classified result. Design mirrors probeTraceConnection.
  verify(host: string, botToken: string, channelId?: string): Promise<MattermostProbeResult>;
}
