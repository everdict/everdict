import type { GithubAppCreds, GithubAppGateway, GithubInstallationRepo } from "@everdict/application-control";
import { z } from "zod";
import { getInstallation, mintInstallationToken } from "../oauth/github-app.js";
import { oauthFetchJson } from "../oauth/provider.js";

// The fetch-backed GitHub App gateway adapter — owns the REST endpoints, headers, and zod response
// parsing behind the GithubAppGateway port. Moved out of github-app-service in re-architecture P2d.
// The App-JWT/installation-token plumbing is reused from infrastructure/oauth (not duplicated);
// non-2xx already surfaces as UpstreamError from those helpers.

// GitHub API base — github.com is api.github.com, GHE is host/api/v3. Determined by the installation host.
function apiBase(host?: string): string {
  if (!host) return "https://api.github.com";
  const trimmed = host.endsWith("/") ? host.slice(0, -1) : host;
  return `${trimmed}/api/v3`;
}

// Headers for a GitHub API call with an installation token.
function appTokenHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "everdict",
    "content-type": "application/json",
  };
}

const InstallationReposResponse = z.object({
  repositories: z.array(
    z.object({
      full_name: z.string(),
      private: z.boolean(),
      default_branch: z.string(),
      pushed_at: z.string().nullable().optional(),
    }),
  ),
});
const RunnerTokenResponse = z.object({ token: z.string(), expires_at: z.string() });

export function githubAppGateway(): GithubAppGateway {
  return {
    async installationAccount(creds: GithubAppCreds, installationId, host) {
      return getInstallation({
        ...(host ? { host } : {}),
        appId: creds.appId,
        privateKeyPem: creds.privateKeyPem,
        installationId,
        nowSec: creds.nowSec,
      });
    },
    async mintInstallationToken(creds: GithubAppCreds, installationId, opts, host) {
      const tok = await mintInstallationToken({
        ...(host ? { host } : {}),
        appId: creds.appId,
        privateKeyPem: creds.privateKeyPem,
        installationId,
        ...(opts.repositories ? { repositories: opts.repositories } : {}),
        ...(opts.permissions ? { permissions: opts.permissions } : {}),
        nowSec: creds.nowSec,
      });
      return { token: tok.token };
    },
    async listInstallationRepos(token, host): Promise<GithubInstallationRepo[]> {
      const body = await oauthFetchJson(`${apiBase(host)}/installation/repositories?per_page=100`, {
        headers: appTokenHeaders(token),
      });
      return InstallationReposResponse.parse(body).repositories.map((r) => ({
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        ...(r.pushed_at ? { pushedAt: r.pushed_at } : {}),
      }));
    },
    async runnerRegistrationToken(token, target, host) {
      const path = "repo" in target ? `/repos/${target.repo}` : `/orgs/${target.org}`;
      const body = await oauthFetchJson(`${apiBase(host)}${path}/actions/runners/registration-token`, {
        method: "POST",
        headers: appTokenHeaders(token),
      });
      const data = RunnerTokenResponse.parse(body);
      return { token: data.token, expiresAt: data.expires_at };
    },
  };
}
