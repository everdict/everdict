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

// A channel the bot can access (across its teams). `type` is the Mattermost channel type ("O" open / "P" private /
// "D" direct / "G" group). Shaped by the adapter from the wire; the use-case ships it verbatim to the agent.
export interface MattermostChannel {
  id: string;
  name: string; // url-safe name
  displayName: string; // human-readable name
  teamId: string;
  type: string;
}

// One post in a channel, newest-first. `createdAt` is epoch ms (Mattermost `create_at`). Author is the user id
// (name resolution would be extra round-trips — the agent can request it separately if needed).
export interface MattermostPostView {
  id: string;
  userId: string;
  message: string;
  createdAt: number;
}

export interface MattermostClient {
  post(host: string, botToken: string, post: MattermostPost): Promise<void>;
  // Connection test run before registration (strict on save + the explicit /probe): the bot token authenticates
  // against {host}/api/v4/users/me and, when a channelId is given, {host}/api/v4/channels/{id} is checked. Never
  // throws for reachability — returns a classified result. Design mirrors probeTraceConnection.
  verify(host: string, botToken: string, channelId?: string): Promise<MattermostProbeResult>;
  // Read tools (using the integration): the channels the bot is a member of across its teams, and the recent posts in
  // a channel (newest-first, up to perPage). Like post(), a transport/non-2xx failure is a remapped AppError so the
  // agent learns the read failed (not a silent empty list).
  listChannels(host: string, botToken: string): Promise<MattermostChannel[]>;
  getChannelPosts(host: string, botToken: string, channelId: string, perPage: number): Promise<MattermostPostView[]>;
}
