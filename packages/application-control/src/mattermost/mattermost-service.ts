import { BadRequestError, NotFoundError } from "@everdict/contracts";
import { DEFAULT_MATTERMOST_CONNECTION, type MattermostConnection, mattermostConnections } from "@everdict/domain";
import type {
  MattermostChannel,
  MattermostClient,
  MattermostPostView,
  MattermostProbeResult,
} from "../ports/mattermost-client.js";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// Workspace-owned Mattermost integration service — an admin registers the workspace's bots + channels against the
// operator-configured Mattermost server (replacing personal connected-account notifications). The server URL is an
// operator env (MATTERMOST_HOST), shared across the deployment — the self-hosted operator registers it once, so
// workspaces never input a host. A workspace registers MULTIPLE connections (one bot+channel per team/purpose,
// keyed by name): completion/regression notifications fan out to every connection with a channel, and the inbound
// slash command accepts any connection's command token. Registration is verified against the live server (strict):
// the bot token must authenticate and, when given, the channel must be accessible. No secrets: botTokenSecretName
// is a SecretStore name reference. The HTTP routes and MCP tools share this core.
// Design: docs/architecture/workspace-scoped-integrations.md

// One workspace Mattermost connection (no secrets — all name references / URLs). host is NOT here (operator env).
export interface MattermostConfigView {
  name: string;
  botTokenSecretName: string;
  defaultChannelId?: string;
  // SecretStore name of the inbound (slash-command/button) verification token. Setting it activates the /everdict command and buttons.
  commandTokenSecretName?: string;
  // Inbound URLs (apiPublicUrl-based) for the admin to register on the MM side. Only meaningful when commandTokenSecretName is set.
  commandUrl?: string;
  actionUrl?: string;
}

// GET status — host is the operator-configured server URL (absent = MATTERMOST_HOST unset → integration unavailable);
// connections is empty when the workspace hasn't registered a bot yet.
export interface MattermostStatus {
  host?: string;
  connections: MattermostConfigView[];
}

export interface MattermostServiceConfig {
  host?: string; // operator-configured Mattermost server URL (MATTERMOST_HOST). Unset → integration unavailable.
  apiPublicUrl?: string; // base for the inbound URLs (slash-command/action). If unset, URLs are not exposed.
}

export interface MattermostServiceDeps {
  settings: WorkspaceSettingsStore;
  client: MattermostClient; // verify() — connection test against the live server before saving
  secretsFor: (workspace: string) => Promise<Record<string, string>>; // botTokenSecretName → value (verify only, never returned)
  config?: MattermostServiceConfig;
}

export class MattermostService {
  private readonly settings: WorkspaceSettingsStore;
  private readonly client: MattermostClient;
  private readonly secretsFor: (workspace: string) => Promise<Record<string, string>>;
  private readonly config: MattermostServiceConfig;
  constructor(deps: MattermostServiceDeps) {
    this.settings = deps.settings;
    this.client = deps.client;
    this.secretsFor = deps.secretsFor;
    this.config = deps.config ?? {};
  }

  // Routes by carrying the workspace slug in the inbound URL (the slug is not a secret — authenticity is handled by commandToken verification).
  private inboundUrls(workspace: string): { commandUrl?: string; actionUrl?: string } {
    const base = this.config.apiPublicUrl;
    if (!base) return {};
    const b = base.endsWith("/") ? base.slice(0, -1) : base;
    const ws = encodeURIComponent(workspace);
    return {
      commandUrl: `${b}/integrations/mattermost/command?ws=${ws}`,
      actionUrl: `${b}/integrations/mattermost/action?ws=${ws}`,
    };
  }

  private view(workspace: string, connection: MattermostConnection): MattermostConfigView {
    const urls = connection.commandTokenSecretName ? this.inboundUrls(workspace) : {};
    return {
      name: connection.name,
      botTokenSecretName: connection.botTokenSecretName,
      ...(connection.defaultChannelId ? { defaultChannelId: connection.defaultChannelId } : {}),
      ...(connection.commandTokenSecretName ? { commandTokenSecretName: connection.commandTokenSecretName } : {}),
      ...(urls.commandUrl ? { commandUrl: urls.commandUrl } : {}),
      ...(urls.actionUrl ? { actionUrl: urls.actionUrl } : {}),
    };
  }

  // Current connections — the plural list, else the legacy singular registration lifted in as name="default".
  private async connections(workspace: string): Promise<MattermostConnection[]> {
    return mattermostConnections(await this.settings.get(workspace));
  }

  // Status — operator server URL (env) + this workspace's connections (empty when none).
  async get(workspace: string): Promise<MattermostStatus> {
    const connections = (await this.connections(workspace)).map((c) => this.view(workspace, c));
    return { ...(this.config.host ? { host: this.config.host } : {}), connections };
  }

  // The operator-configured server URL, or a BadRequest when unset (MATTERMOST_HOST env not configured).
  private requireHost(): string {
    if (!this.config.host)
      throw new BadRequestError(
        "BAD_REQUEST",
        {},
        "Mattermost server is not configured (MATTERMOST_HOST env). Ask the operator to register the server URL.",
      );
    return this.config.host;
  }

  // Resolve the bot token VALUE from the workspace SecretStore (never returned to a caller). Missing → BadRequest.
  private async botTokenValue(workspace: string, name: string): Promise<string> {
    const token = (await this.secretsFor(workspace))[name];
    if (!token)
      throw new BadRequestError("BAD_REQUEST", { name }, `Bot token not found in the workspace SecretStore: ${name}`);
    return token;
  }

  // Connection test (explicit /probe + reused inside set) — verify the bot token (+ optional channel) against the server.
  // Never throws for reachability (returns classified); only a config error (no host / missing secret) throws.
  async probe(
    workspace: string,
    input: { botTokenSecretName: string; defaultChannelId?: string },
  ): Promise<MattermostProbeResult> {
    const host = this.requireHost();
    const token = await this.botTokenValue(workspace, input.botTokenSecretName);
    return this.client.verify(host, token, input.defaultChannelId);
  }

  // Register/update one connection (admin, upsert by name). Strict: the bot token (+ channel if given) must verify
  // against the live server first — a failed connection blocks the save with the classified reason. Put the bot token
  // value in the SecretStore first. An omitted channel/command token keeps what that connection already had (a partial
  // update of one connection), and the first write migrates the legacy singular registration into the list.
  async set(
    workspace: string,
    input: {
      name?: string;
      botTokenSecretName: string;
      defaultChannelId?: string;
      commandTokenSecretName?: string;
    },
  ): Promise<MattermostConfigView> {
    const host = this.requireHost();
    const token = await this.botTokenValue(workspace, input.botTokenSecretName);
    const result = await this.client.verify(host, token, input.defaultChannelId);
    if (!result.reachable)
      throw new BadRequestError(
        "BAD_REQUEST",
        { reason: result.reason ?? "error" },
        `Could not connect to Mattermost: ${result.detail}`,
      );
    const name = input.name ?? DEFAULT_MATTERMOST_CONNECTION;
    const current = await this.connections(workspace);
    const existing = current.find((c) => c.name === name);
    const defaultChannelId = input.defaultChannelId ?? existing?.defaultChannelId;
    const commandTokenSecretName = input.commandTokenSecretName ?? existing?.commandTokenSecretName;
    const entry: MattermostConnection = {
      name,
      botTokenSecretName: input.botTokenSecretName,
      ...(defaultChannelId ? { defaultChannelId } : {}),
      ...(commandTokenSecretName ? { commandTokenSecretName } : {}),
    };
    // Update IN PLACE — the list order is what the settings UI shows and what "the first connection" (the default
    // post target) means, so editing one connection must never reshuffle the others.
    const next = current.some((c) => c.name === name)
      ? current.map((c) => (c.name === name ? entry : c))
      : [...current, entry];
    await this.settings.set(workspace, { mattermostConnections: next, mattermost: null });
    return this.view(workspace, entry);
  }

  // Remove one connection (admin, by name). Its channel stops receiving notifications; the others are untouched.
  // The legacy singular field is nulled out on every write (the jsonb merge || can't delete a key).
  async remove(workspace: string, name: string): Promise<void> {
    const next = (await this.connections(workspace)).filter((c) => c.name !== name);
    await this.settings.set(workspace, { mattermostConnections: next, mattermost: null });
  }

  // Select the connection an operation acts through: by name when given (unknown → 404), else the first registered
  // one (the workspace's default target for agent posts/reads). No connection at all → BadRequest telling the caller
  // to register one — every "use the integration" op needs a registered bot.
  private async selectConnection(workspace: string, name?: string): Promise<MattermostConnection> {
    const connections = await this.connections(workspace);
    if (name !== undefined) {
      const found = connections.find((c) => c.name === name);
      if (!found) throw new NotFoundError("NOT_FOUND", { name }, `Mattermost connection is not registered: ${name}`);
      return found;
    }
    const first = connections[0];
    if (!first)
      throw new BadRequestError(
        "BAD_REQUEST",
        {},
        "Mattermost is not registered for this workspace. An admin must register a bot token first (Settings → Integrations).",
      );
    return first;
  }

  // List the channels the workspace bot can access (across its teams) — for the agent to discover a channel id before
  // reading it. Requires the operator server URL + a registered bot (connection selects which one).
  async listChannels(workspace: string, connection?: string): Promise<{ channels: MattermostChannel[] }> {
    const host = this.requireHost();
    const target = await this.selectConnection(workspace, connection);
    const token = await this.botTokenValue(workspace, target.botTokenSecretName);
    return { channels: await this.client.listChannels(host, token) };
  }

  // Read recent posts in a channel (newest-first, clamped to 1..100). Requires the operator server URL + a registered
  // bot with access to the channel (a transport/non-2xx failure surfaces as the adapter's remapped UpstreamError).
  async getChannelPosts(
    workspace: string,
    channelId: string,
    limit?: number,
    connection?: string,
  ): Promise<{ posts: MattermostPostView[] }> {
    const host = this.requireHost();
    const target = await this.selectConnection(workspace, connection);
    const token = await this.botTokenValue(workspace, target.botTokenSecretName);
    const perPage = Math.min(Math.max(limit ?? 30, 1), 100);
    return { posts: await this.client.getChannelPosts(host, token, channelId, perPage) };
  }

  // Post a message to a connection's channel as its bot (the conversational agent's post_mattermost_message tool +
  // its HTTP/MCP endpoint) — the named connection, else the first registered one. Unlike completion notifications
  // (fire-and-forget fan-out), failure is SURFACED — the agent must know whether the post landed, so config gaps
  // throw BadRequest and a transport/HTTP failure propagates as the adapter's remapped UpstreamError. Returns the
  // connection + channel it landed in.
  async postMessage(
    workspace: string,
    message: string,
    connection?: string,
  ): Promise<{ connection: string; channelId: string }> {
    const host = this.requireHost();
    const target = await this.selectConnection(workspace, connection);
    if (!target.defaultChannelId)
      throw new BadRequestError(
        "BAD_REQUEST",
        { connection: target.name },
        `The Mattermost connection '${target.name}' has no channel configured. An admin must set its channel first.`,
      );
    const token = await this.botTokenValue(workspace, target.botTokenSecretName);
    await this.client.post(host, token, { channelId: target.defaultChannelId, message });
    return { connection: target.name, channelId: target.defaultChannelId };
  }
}
