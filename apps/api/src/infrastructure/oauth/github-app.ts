import { sign } from "node:crypto";
import { z } from "zod";
import { oauthFetchJson } from "./provider.js";

// GitHub App (installation) token minting — the core of workspace-owned integrations (replaces personal OAuth connections).
// Unlike an OAuth App's `repo` scope (all-or-nothing across all repos), an App yields a short-lived (~1h) installation
// access token that GitHub itself restricts to the repos chosen at install time + the granted permissions. Presence of host handles github.com↔GHE together.
// Design: docs/architecture/workspace-scoped-integrations.md

// host="https://ghe.acme.io" → api base = host/api/v3. If absent, api.github.com (github.com).
function apiBase(host?: string): string {
  if (!host) return "https://api.github.com";
  const trimmed = host.endsWith("/") ? host.slice(0, -1) : host;
  return `${trimmed}/api/v3`;
}

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

// App JWT (RS256) — iss=appId, expires within 10 minutes. Signed with the PEM private key (Node built-in crypto — no external dependency).
// Backdates iat by 60s to absorb control-plane↔GitHub clock skew (GitHub-recommended). Injecting nowSec → deterministic tests.
export function githubAppJwt(input: { appId: string; privateKeyPem: string; nowSec: number }): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: input.nowSec - 60, exp: input.nowSec + 540, iss: input.appId }));
  const data = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(data), input.privateKeyPem).toString("base64url");
  return `${data}.${signature}`;
}

// installation token response — only the two fields we need (the rest ignored). On failure, oauthFetchJson remaps to UpstreamError.
const InstallationTokenResponse = z.object({ token: z.string(), expires_at: z.string() });

export interface InstallationToken {
  token: string;
  expiresAt: string; // ISO — this token's expiry (about an hour out)
}

// Mint an installation access token — authenticate with the App JWT and narrow the request by repositories/permissions.
// repositories: an array of repo **names** under the owning account (owner omitted — the installation already owns that account). If unset, the whole installation.
// permissions: e.g. { contents: "read" } (clone). If unset, the App's granted default permissions.
export async function mintInstallationToken(input: {
  host?: string;
  appId: string;
  privateKeyPem: string;
  installationId: number;
  repositories?: string[];
  permissions?: Record<string, string>;
  nowSec: number;
}): Promise<InstallationToken> {
  const jwt = githubAppJwt({ appId: input.appId, privateKeyPem: input.privateKeyPem, nowSec: input.nowSec });
  const body = await oauthFetchJson(`${apiBase(input.host)}/app/installations/${input.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "user-agent": "everdict", // GitHub API requires a User-Agent
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...(input.repositories ? { repositories: input.repositories } : {}),
      ...(input.permissions ? { permissions: input.permissions } : {}),
    }),
  });
  const parsed = InstallationTokenResponse.parse(body);
  return { token: parsed.token, expiresAt: parsed.expires_at };
}

// installation meta — only the installed org/user login is needed (used to determine account in the callback).
const InstallationInfo = z.object({ account: z.object({ login: z.string() }) });

// installation lookup — GET /app/installations/{id} with the App JWT. The install callback gives only installation_id, so
// we determine the account (org login) to store here. github.com↔GHE via the presence of host.
export async function getInstallation(input: {
  host?: string;
  appId: string;
  privateKeyPem: string;
  installationId: number;
  nowSec: number;
}): Promise<{ account: string }> {
  const jwt = githubAppJwt({ appId: input.appId, privateKeyPem: input.privateKeyPem, nowSec: input.nowSec });
  const body = await oauthFetchJson(`${apiBase(input.host)}/app/installations/${input.installationId}`, {
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "user-agent": "everdict",
    },
  });
  return { account: InstallationInfo.parse(body).account.login };
}
