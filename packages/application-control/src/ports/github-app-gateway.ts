// Outbound GitHub App gateway port (re-architecture P2d) — the workspace-App use-case owns the
// sameHost/installation-selection/upsert/state semantics and resolves the App credentials (env for
// github.com, the GHE registration's SecretStore key otherwise); the adapter owns the URLs, the App
// JWT/installation-token plumbing, the request headers, the zod response parsing, and the error
// remapping (apps/api infrastructure/github). Credentials + nowSec are explicit parameters so the
// deterministic tests keep pinning the wire bytes. Non-2xx surfaces as UpstreamError from the adapter.
// Design: docs/architecture/workspace-scoped-integrations.md

// App credentials for one call — resolved by the use-case (env github.com App or the GHE registration).
export interface GithubAppCreds {
  appId: string;
  privateKeyPem: string;
  nowSec: number; // App-JWT clock (injected → deterministic tests)
}

// One picker row — the normalized repos an installation can access (only the ones chosen at install time).
// host is stamped on by the use-case (the gateway does not know which installation host this is for).
export interface GithubInstallationRepo {
  fullName: string; // "owner/name"
  private: boolean;
  defaultBranch: string;
  pushedAt?: string;
}

export interface GithubAppGateway {
  // GET /app/installations/{id} — confirm the installed account (org/user login) at callback time.
  installationAccount(creds: GithubAppCreds, installationId: number, host?: string): Promise<{ account: string }>;
  // POST /app/installations/{id}/access_tokens — mint an installation token, narrowed by repositories?/permissions?.
  mintInstallationToken(
    creds: GithubAppCreds,
    installationId: number,
    opts: { repositories?: string[]; permissions?: Record<string, string> },
    host?: string,
  ): Promise<{ token: string }>;
  // GET /installation/repositories — the repos this installation can access (already normalized).
  listInstallationRepos(token: string, host?: string): Promise<GithubInstallationRepo[]>;
  // POST /repos|orgs/.../actions/runners/registration-token — a GitHub Actions runner registration token.
  runnerRegistrationToken(
    token: string,
    target: { repo: string } | { org: string },
    host?: string,
  ): Promise<{ token: string; expiresAt: string }>;
}
