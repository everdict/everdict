import { UpstreamError } from "@everdict/contracts";

// Outbound OAuth client abstraction — Everdict as the OAuth "client" of an external provider (GitHub/GHE/Mattermost).
// (The opposite direction from inbound Keycloak: we request permission from an external account.)
// A provider is a **stateless kind** — credentials/host are injected as config at call time (github.com=env default,
// self-hosted=workspace SecretStore name-ref). One impl handles both github.com↔GHE via the presence of host.
export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  host?: string; // self-hosted base (GHE/Mattermost). Omit for github.com.
}

export interface OAuthExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // access token expiry (if any) — for deciding refresh
  scopes: string[]; // the actually granted scopes
}

export interface OAuthAccount {
  label: string; // display account identifier (e.g. github login)
}

export interface OAuthProvider {
  readonly defaultScopes: string[]; // requested scopes
  // elevated (opt-in) scopes — what can be requested on top of the default (e.g. github's admin:org, for org runner registration). None means no elevation.
  readonly elevatedScopes?: string[];
  // The authorize URL to send the user's browser to (includes state + redirect_uri). If scopes is unset, defaultScopes.
  authorizeUrl(input: { config: OAuthProviderConfig; state: string; redirectUri: string; scopes?: string[] }): string;
  // callback code → token exchange (server-to-server, client_secret). Failures remap to AppError (UpstreamError).
  exchange(input: { config: OAuthProviderConfig; code: string; redirectUri: string }): Promise<OAuthExchangeResult>;
  // Look up the account identifier by token (display label).
  whoami(input: { config: OAuthProviderConfig; accessToken: string }): Promise<OAuthAccount>;
}

// JSON fetch + remap external failures to UpstreamError (don't propagate raw errors to the caller).
// Shared by the github/mattermost providers. fetch failure / parse failure / non-2xx are all UpstreamError.
export async function oauthFetchJson(url: string, init: Parameters<typeof fetch>[1]): Promise<unknown> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { url },
      `external request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { url, status: res.status },
        `failed to parse external response (status ${res.status})`,
      );
    }
  }
  if (!res.ok)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { url, status: res.status },
      `external request failed (status ${res.status})`,
    );
  return json;
}
