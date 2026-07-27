import type {
  MattermostChannel,
  MattermostClient,
  MattermostPostView,
  MattermostProbeResult,
} from "@everdict/application-control";
import { UpstreamError } from "@everdict/contracts";

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
      // Surface failures as our own error (never a raw fetch error): a transport failure or a non-2xx from
      // Mattermost is remapped to UpstreamError. Fire-and-forget callers (completion notifications) swallow it in
      // their own try/catch; the agent's post_mattermost_message tool lets it propagate so the user learns it failed.
      let res: Response;
      try {
        res = await fetchImpl(`${base}/api/v4/posts`, {
          method: "POST",
          headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            channel_id: post.channelId,
            message: post.message,
            ...(post.attachments ? { props: { attachments: post.attachments } } : {}),
          }),
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { detail },
          `Could not reach Mattermost to post the message: ${detail}`,
        );
      }
      if (!res.ok)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status },
          `Mattermost rejected the post (HTTP ${res.status}).`,
        );
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
    // GET /api/v4/users/me/teams → the bot's teams, then per team GET /users/me/teams/{team}/channels → the channels
    // the bot is a member of. Flattened; a transport/non-2xx failure is remapped (never a raw fetch error).
    async listChannels(host, botToken): Promise<MattermostChannel[]> {
      const base = trimSlash(host);
      const teams = await getJson(fetchImpl, `${base}/api/v4/users/me/teams`, botToken, "list Mattermost teams");
      const teamIds = (Array.isArray(teams) ? teams : [])
        .map((t) => (isRecord(t) && typeof t.id === "string" ? t.id : undefined))
        .filter((id): id is string => id !== undefined);
      const channels: MattermostChannel[] = [];
      for (const teamId of teamIds) {
        const list = await getJson(
          fetchImpl,
          `${base}/api/v4/users/me/teams/${encodeURIComponent(teamId)}/channels`,
          botToken,
          "list Mattermost channels",
        );
        for (const c of Array.isArray(list) ? list : []) {
          if (!isRecord(c) || typeof c.id !== "string") continue;
          channels.push({
            id: c.id,
            name: typeof c.name === "string" ? c.name : "",
            displayName: typeof c.display_name === "string" ? c.display_name : "",
            teamId: typeof c.team_id === "string" ? c.team_id : teamId,
            type: typeof c.type === "string" ? c.type : "",
          });
        }
      }
      return channels;
    },
    // GET /api/v4/channels/{id}/posts?per_page=N → { order:[ids newest-first], posts:{id:post} }; mapped in order.
    async getChannelPosts(host, botToken, channelId, perPage): Promise<MattermostPostView[]> {
      const base = trimSlash(host);
      const body = await getJson(
        fetchImpl,
        `${base}/api/v4/channels/${encodeURIComponent(channelId)}/posts?per_page=${perPage}`,
        botToken,
        "read Mattermost channel posts",
      );
      if (!isRecord(body)) return [];
      const order = Array.isArray(body.order) ? body.order : [];
      const posts = isRecord(body.posts) ? body.posts : {};
      const out: MattermostPostView[] = [];
      for (const id of order) {
        if (typeof id !== "string") continue;
        const p = posts[id];
        if (!isRecord(p)) continue;
        out.push({
          id,
          userId: typeof p.user_id === "string" ? p.user_id : "",
          message: typeof p.message === "string" ? p.message : "",
          createdAt: typeof p.create_at === "number" ? p.create_at : 0,
        });
      }
      return out;
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// A GET returning parsed JSON, with the same error discipline as post(): a transport failure, a non-2xx, or an
// unreadable body is remapped to UpstreamError (never a raw fetch/parse error crossing the boundary).
async function getJson(fetchImpl: typeof fetch, url: string, botToken: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: botHeaders(botToken) });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new UpstreamError("UPSTREAM_ERROR", { detail }, `Could not reach Mattermost to ${what}: ${detail}`);
  }
  if (!res.ok)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { status: res.status },
      `Mattermost failed to ${what} (HTTP ${res.status}).`,
    );
  try {
    return await res.json();
  } catch {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      {},
      `Mattermost returned an unreadable response while trying to ${what}.`,
    );
  }
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
