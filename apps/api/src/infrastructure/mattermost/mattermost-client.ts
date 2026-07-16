import type { MattermostClient, MattermostProbeResult } from "@everdict/application-control";

// The fetch-backed Mattermost adapter — owns the wire protocol (/api/v4/*, bot-token bearer,
// props.attachments envelope). The injectable fetch keeps tests recording the exact wire bytes.
const trimSlash = (host: string): string => (host.endsWith("/") ? host.slice(0, -1) : host);
const PROBE_TIMEOUT_MS = 10_000;

// Bearer header for a bot-token call.
function botHeaders(botToken: string): Record<string, string> {
  return { authorization: `Bearer ${botToken}`, accept: "application/json" };
}

export function mattermostHttpClient(fetchImpl: typeof fetch = fetch): MattermostClient {
  return {
    async post(host, botToken, post) {
      const base = trimSlash(host);
      await fetchImpl(`${base}/api/v4/posts`, {
        method: "POST",
        headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          channel_id: post.channelId,
          message: post.message,
          ...(post.attachments ? { props: { attachments: post.attachments } } : {}),
        }),
      });
    },
    // Connection test — GET /api/v4/users/me authenticates the bot token; GET /api/v4/channels/{id} confirms the
    // channel is reachable. Never throws for reachability: a network/DNS/timeout failure is classified as a result.
    async verify(host, botToken, channelId): Promise<MattermostProbeResult> {
      const base = trimSlash(host);
      const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      let me: Response;
      try {
        me = await fetchImpl(`${base}/api/v4/users/me`, { headers: botHeaders(botToken), signal });
      } catch (e) {
        return { reachable: false, reason: "unreachable", detail: e instanceof Error ? e.message : String(e) };
      }
      if (me.status === 401 || me.status === 403)
        return { reachable: false, reason: "auth", detail: `Bot token rejected (users/me ${me.status}).` };
      if (!me.ok) return { reachable: false, reason: "error", detail: `Mattermost users/me ${me.status}.` };
      const botUsername = await usernameOf(me);
      if (!channelId)
        return { reachable: true, detail: "Bot token verified.", ...(botUsername ? { botUsername } : {}) };
      let ch: Response;
      try {
        ch = await fetchImpl(`${base}/api/v4/channels/${encodeURIComponent(channelId)}`, {
          headers: botHeaders(botToken),
          signal,
        });
      } catch (e) {
        return { reachable: false, reason: "unreachable", detail: e instanceof Error ? e.message : String(e) };
      }
      if (ch.status === 401 || ch.status === 403 || ch.status === 404)
        return { reachable: false, reason: "channel", detail: `Channel not accessible (${ch.status}).` };
      if (!ch.ok)
        return { reachable: false, reason: "error", detail: `Mattermost channels/${channelId} ${ch.status}.` };
      const channelName = await channelNameOf(ch);
      return {
        reachable: true,
        detail: "Bot token and channel verified.",
        ...(botUsername ? { botUsername } : {}),
        ...(channelName ? { channelName } : {}),
      };
    },
  };
}

// Best-effort field reads — a missing/oddly-shaped body must not turn a 200 into a failure.
async function usernameOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { username?: unknown };
    return typeof body.username === "string" ? body.username : undefined;
  } catch {
    return undefined;
  }
}
async function channelNameOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { display_name?: unknown; name?: unknown };
    if (typeof body.display_name === "string" && body.display_name) return body.display_name;
    return typeof body.name === "string" ? body.name : undefined;
  } catch {
    return undefined;
  }
}
