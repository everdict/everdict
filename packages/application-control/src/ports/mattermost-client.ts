// Outbound Mattermost port (re-architecture P2d) — the use-case layer decides WHEN to notify and
// WHAT the message says; the wire protocol (endpoint path, auth header, body shape) is the adapter's
// (apps/api infrastructure/mattermost). Failure handling stays with the caller (fire-and-forget).
export interface MattermostPost {
  channelId: string;
  message: string;
  attachments?: unknown[]; // message-attachment payloads (e.g. the interactive Rerun button) — assembled by the use-case, shipped verbatim
}

export interface MattermostClient {
  post(host: string, botToken: string, post: MattermostPost): Promise<void>;
}
