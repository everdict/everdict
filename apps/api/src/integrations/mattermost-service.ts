import type { WorkspaceSettings, WorkspaceSettingsStore } from "@everdict/db";

// Workspace-owned Mattermost integration service — an admin registers the company Mattermost once for the workspace (replacing personal connected-account notifications).
// Outbound notifications are posted by NotificationService, which reads settings.mattermost and posts with the bot token.
// No secrets: botTokenSecretName is a SecretStore name reference, not a value, so it is safe to return. The HTTP routes and MCP tools share this core.
// Design: docs/architecture/workspace-scoped-integrations.md

// Workspace Mattermost status (no secrets — all name references / URLs). The admin registers the inbound URLs on the MM slash-command/action.
export interface MattermostConfigView {
  host: string;
  botTokenSecretName: string;
  defaultChannelId?: string;
  // SecretStore name of the inbound (slash-command/button) verification token. Setting it activates the /everdict command and buttons.
  commandTokenSecretName?: string;
  // Inbound URLs (apiPublicUrl-based) for the admin to register on the MM side. Only meaningful when commandTokenSecretName is set.
  commandUrl?: string;
  actionUrl?: string;
}

export interface MattermostServiceConfig {
  apiPublicUrl?: string; // base for the inbound URLs (slash-command/action). If unset, URLs are not exposed.
}

type MattermostSettings = NonNullable<WorkspaceSettings["mattermost"]>;

export class MattermostService {
  constructor(
    private readonly settings: WorkspaceSettingsStore,
    private readonly config: MattermostServiceConfig = {},
  ) {}

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

  async get(workspace: string): Promise<MattermostConfigView | undefined> {
    const mm = (await this.settings.get(workspace))?.mattermost;
    if (!mm) return undefined; // null (cleared) or unset
    const urls = mm.commandTokenSecretName ? this.inboundUrls(workspace) : {};
    return {
      host: mm.host,
      botTokenSecretName: mm.botTokenSecretName,
      ...(mm.defaultChannelId ? { defaultChannelId: mm.defaultChannelId } : {}),
      ...(mm.commandTokenSecretName ? { commandTokenSecretName: mm.commandTokenSecretName } : {}),
      ...(urls.commandUrl ? { commandUrl: urls.commandUrl } : {}),
      ...(urls.actionUrl ? { actionUrl: urls.actionUrl } : {}),
    };
  }

  // Register/update (admin). Put the bot token (value) into the SecretStore first and pass only its name. commandTokenSecretName is the inbound-verification token.
  async set(
    workspace: string,
    input: {
      host: string;
      botTokenSecretName: string;
      defaultChannelId?: string;
      commandTokenSecretName?: string;
    },
  ): Promise<MattermostConfigView> {
    const existing = (await this.settings.get(workspace))?.mattermost ?? undefined;
    const defaultChannelId = input.defaultChannelId ?? existing?.defaultChannelId;
    const commandTokenSecretName = input.commandTokenSecretName ?? existing?.commandTokenSecretName;
    const next: MattermostSettings = {
      host: input.host,
      botTokenSecretName: input.botTokenSecretName,
      ...(defaultChannelId ? { defaultChannelId } : {}),
      ...(commandTokenSecretName ? { commandTokenSecretName } : {}),
    };
    await this.settings.set(workspace, { mattermost: next });
    const got = await this.get(workspace);
    return got ?? { host: next.host, botTokenSecretName: next.botTokenSecretName };
  }

  // Clear (admin). The jsonb merge || can't delete a key, so null-out to invalidate it (read as undefined).
  async clear(workspace: string): Promise<void> {
    await this.settings.set(workspace, { mattermost: null });
  }
}
