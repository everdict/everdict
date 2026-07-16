import type { WorkspaceProxy, WorkspaceSettings } from "@everdict/contracts";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// Workspace BYO egress proxy pool (browser-profiles S4) — per-country proxies for the interactive login browser
// (and eval browsers, S5). Register several by name; a session/profile selects a country → resolve() builds the
// Chrome --proxy-server value (folding in the auth secret when configured). Registration is admin (settings:write),
// list is a workspace read; the auth secret is a SecretStore name-ref (the value is resolved at resolve() time,
// never persisted/returned). HTTP routes + MCP tools share this core. Design: docs/architecture/browser-profiles.md.

// Proxy state (no secret value — the name-ref only).
export interface ProxyView {
  name: string;
  country: string;
  url: string;
  authSecretName?: string;
}

export interface ProxyServiceDeps {
  settings: WorkspaceSettingsStore;
  secretsFor: (workspace: string) => Promise<Record<string, string>>; // shared (workspace) secret tier
}

type ProxyEntry = NonNullable<WorkspaceSettings["proxies"]>[number];

function toView(p: ProxyEntry): ProxyView {
  return {
    name: p.name,
    country: p.country,
    url: p.url,
    ...(p.authSecretName ? { authSecretName: p.authSecretName } : {}),
  };
}

// Fold "user:pass" into a proxy URL → scheme://user:pass@host:port (default scheme http). NOTE: headless Chrome does
// not honor inline proxy auth for the auth *challenge* — full support needs CDP Fetch.continueWithAuth (a follow-up);
// this covers open proxies + setups that accept inline creds, and keeps the credential a SecretStore ref.
function withAuth(url: string, creds: string): string {
  const schemeEnd = url.indexOf("://");
  const scheme = schemeEnd >= 0 ? url.slice(0, schemeEnd + 3) : "http://";
  const rest = schemeEnd >= 0 ? url.slice(schemeEnd + 3) : url;
  return `${scheme}${creds}@${rest}`;
}

export class ProxyService {
  constructor(private readonly deps: ProxyServiceDeps) {}

  private async entries(workspace: string): Promise<ProxyEntry[]> {
    return (await this.deps.settings.get(workspace))?.proxies ?? [];
  }

  async list(workspace: string): Promise<ProxyView[]> {
    return (await this.entries(workspace)).map(toView);
  }

  // Register/update (admin, upsert by name — declarative full replace). Surfaces a missing referenced secret as a
  // warning (the secret can be added later) rather than rejecting.
  async upsert(
    workspace: string,
    input: WorkspaceProxy,
  ): Promise<{ config: ProxyView; missingSecrets?: string[] }> {
    const entry: ProxyEntry = {
      name: input.name,
      country: input.country,
      url: input.url,
      ...(input.authSecretName ? { authSecretName: input.authSecretName } : {}),
    };
    const current = await this.entries(workspace);
    const next = [...current.filter((p) => p.name !== input.name), entry];
    await this.deps.settings.set(workspace, { proxies: next });
    let missingSecrets: string[] | undefined;
    if (input.authSecretName) {
      const have = new Set(Object.keys(await this.deps.secretsFor(workspace)));
      if (!have.has(input.authSecretName)) missingSecrets = [input.authSecretName];
    }
    return { config: toView(entry), ...(missingSecrets ? { missingSecrets } : {}) };
  }

  async remove(workspace: string, name: string): Promise<void> {
    const next = (await this.entries(workspace)).filter((p) => p.name !== name);
    await this.deps.settings.set(workspace, { proxies: next });
  }

  // Resolve a country → the Chrome --proxy-server value (auth folded in when configured). undefined if the workspace
  // has no proxy for that country (the browser then launches direct).
  async resolve(workspace: string, country: string): Promise<string | undefined> {
    const proxy = (await this.entries(workspace)).find((p) => p.country === country);
    if (!proxy) return undefined;
    if (!proxy.authSecretName) return proxy.url;
    const creds = (await this.deps.secretsFor(workspace))[proxy.authSecretName];
    return creds ? withAuth(proxy.url, creds) : proxy.url; // missing secret → best-effort unauthenticated
  }
}
