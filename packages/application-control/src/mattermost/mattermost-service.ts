import { BadRequestError, type WorkspaceSettings } from "@everdict/contracts";
import type { MattermostClient, MattermostProbeResult } from "../ports/mattermost-client.js";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// Workspace-owned Mattermost integration service — an admin registers the workspace's bot + channel against the
// operator-configured Mattermost server (replacing personal connected-account notifications). The server URL is an
// operator env (MATTERMOST_HOST), shared across the deployment — the self-hosted operator registers it once, so
// workspaces never input a host. Registration is verified against the live server (strict): the bot token must
// authenticate and, when given, the default channel must be accessible. No secrets: botTokenSecretName is a
// SecretStore name reference. The HTTP routes and MCP tools share this core.
// Design: docs/architecture/workspace-scoped-integrations.md

// Workspace Mattermost registration (no secrets — all name references / URLs). host is NOT here (operator env).
export interface MattermostConfigView {
  botTokenSecretName: string;
  defaultChannelId?: string;
  // SecretStore name of the inbound (slash-command/button) verification token. Setting it activates the /everdict command and buttons.
  commandTokenSecretName?: string;
  // Inbound URLs (apiPublicUrl-based) for the admin to register on the MM side. Only meaningful when commandTokenSecretName is set.
  commandUrl?: string;
  actionUrl?: string;
}

// GET status — host is the operator-configured server URL (absent = MATTERMOST_HOST unset → integration unavailable);
// config is absent when the workspace hasn't registered a bot yet.
export interface MattermostStatus {
  host?: string;
  config?: MattermostConfigView;
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

type MattermostSettings = NonNullable<WorkspaceSettings["mattermost"]>;

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

  private view(workspace: string, mm: MattermostSettings): MattermostConfigView {
    const urls = mm.commandTokenSecretName ? this.inboundUrls(workspace) : {};
    return {
      botTokenSecretName: mm.botTokenSecretName,
      ...(mm.defaultChannelId ? { defaultChannelId: mm.defaultChannelId } : {}),
      ...(mm.commandTokenSecretName ? { commandTokenSecretName: mm.commandTokenSecretName } : {}),
      ...(urls.commandUrl ? { commandUrl: urls.commandUrl } : {}),
      ...(urls.actionUrl ? { actionUrl: urls.actionUrl } : {}),
    };
  }

  // Status — operator server URL (env) + this workspace's registration (if any).
  async get(workspace: string): Promise<MattermostStatus> {
    const mm = (await this.settings.get(workspace))?.mattermost;
    return {
      ...(this.config.host ? { host: this.config.host } : {}),
      ...(mm ? { config: this.view(workspace, mm) } : {}),
    };
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

  // Register/update (admin). Strict: the bot token (+ channel if given) must verify against the live server first —
  // a failed connection blocks the save with the classified reason. Put the bot token value in the SecretStore first.
  async set(
    workspace: string,
    input: {
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
    const existing = (await this.settings.get(workspace))?.mattermost ?? undefined;
    const defaultChannelId = input.defaultChannelId ?? existing?.defaultChannelId;
    const commandTokenSecretName = input.commandTokenSecretName ?? existing?.commandTokenSecretName;
    const next: MattermostSettings = {
      botTokenSecretName: input.botTokenSecretName,
      ...(defaultChannelId ? { defaultChannelId } : {}),
      ...(commandTokenSecretName ? { commandTokenSecretName } : {}),
    };
    await this.settings.set(workspace, { mattermost: next });
    return this.view(workspace, next);
  }

  // Clear (admin). The jsonb merge || can't delete a key, so null-out to invalidate it (read as undefined).
  async clear(workspace: string): Promise<void> {
    await this.settings.set(workspace, { mattermost: null });
  }
}
