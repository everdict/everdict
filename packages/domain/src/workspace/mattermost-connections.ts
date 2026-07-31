import type { WorkspaceSettings } from "@everdict/contracts";

// The workspace's Mattermost connections, normalized — the ONE place the plural list and the legacy singular
// registration are reconciled, so every consumer (the integration service, the notification fan-out, the inbound
// token check, the secret reverse-index) sees the same list. A workspace registers one connection per team/purpose
// against the operator's server (MATTERMOST_HOST); notifications fan out to every connection that has a channel.
// Design: docs/architecture/workspace-scoped-integrations.md

export interface MattermostConnection {
  name: string;
  botTokenSecretName: string;
  defaultChannelId?: string;
  commandTokenSecretName?: string;
}

// The legacy singular registration inherits the reserved name — the same convention the image registries use.
export const DEFAULT_MATTERMOST_CONNECTION = "default";

// Plural list when present, else the legacy singular lifted into a one-entry list, else empty. A writer that touches
// the list persists the plural field and nulls the singular one (see MattermostService), so this fallback only ever
// serves rows written before connections existed.
export function mattermostConnections(settings?: WorkspaceSettings | null): MattermostConnection[] {
  if (settings?.mattermostConnections) return settings.mattermostConnections;
  const legacy = settings?.mattermost;
  if (!legacy) return [];
  return [
    {
      name: DEFAULT_MATTERMOST_CONNECTION,
      botTokenSecretName: legacy.botTokenSecretName,
      ...(legacy.defaultChannelId ? { defaultChannelId: legacy.defaultChannelId } : {}),
      ...(legacy.commandTokenSecretName ? { commandTokenSecretName: legacy.commandTokenSecretName } : {}),
    },
  ];
}
