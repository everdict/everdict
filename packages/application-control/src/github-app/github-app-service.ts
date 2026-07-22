import { randomBytes } from "node:crypto";
import { BadRequestError, NotFoundError, type WorkspaceSettings } from "@everdict/contracts";
import type { GithubAppGateway } from "../ports/github-app-gateway.js";
import type { OAuthStateStore } from "../ports/oauth-state-store.js";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// Workspace-owned GitHub App integration service — replaces personal Connected accounts (OAuth tokens).
// Org install → chosen repos → a workspace-owned installation. BOTH github.com and GitHub Enterprise are
// operator env now (config.githubCom / config.githubEnterprise): one App per host for the whole deployment,
// the admin only installs + picks repos (no per-workspace App registration — the two hosts are handled
// identically). The installation issues short-lived tokens on demand from the App private key, so nothing
// secret is stored on the workspace. The HTTP route and the MCP tool share this core (BFF↔MCP parity). The
// GitHub REST protocol (URLs, App-JWT/token plumbing, headers, response parsing, error remapping) lives behind
// GithubAppGateway. Design: docs/architecture/workspace-scoped-integrations.md

type GithubAppSettings = NonNullable<WorkspaceSettings["githubApp"]>;
type Installation = GithubAppSettings["installations"][number];

// An unguessable state nonce. Goes out as the authorize URL's state parameter and comes back as-is in the callback.
function generateOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

// Operator github.com App credentials (env). If unset, the github.com App is disabled.
export interface GithubComAppConfig {
  appId: string;
  privateKeyPem: string;
  slug: string; // used in the install URL github.com/apps/{slug}/installations/new
}

// Operator GitHub Enterprise App credentials (env) — the ONE enterprise host for this deployment, handled
// identically to github.com (env single App). If unset, GHE install is disabled.
export interface GithubEnterpriseAppConfig {
  host: string; // GHE base URL (e.g. https://ghe.acme.io) — the install target + credential-resolution key
  appId: string;
  privateKeyPem: string;
  slug: string; // used in the install URL {host}/github-apps/{slug}/installations/new
}

export interface GithubAppServiceConfig {
  webBaseUrl: string; // web base the browser returns to after the callback (e.g. http://localhost:3001)
  apiPublicUrl?: string; // install-callback (App Setup URL) base. Falls back to the request base if unset.
  stateTtlSec?: number; // pending state expiry (default 600s)
  githubCom?: GithubComAppConfig; // env default github.com App (absent → github.com install disabled)
  githubEnterprise?: GithubEnterpriseAppConfig; // env GitHub Enterprise App (absent → GHE install disabled)
}

// Which App install targets the operator configured (env) — mirrors the wire GithubAppProviders.
export interface GithubAppProviders {
  githubCom: boolean;
  enterprise?: { host: string };
}

// Workspace App integration status (no secrets — installation tokens are minted on demand, nothing token-shaped is stored).
export interface GithubAppView {
  installations: Installation[];
  providers: GithubAppProviders;
}

// One picker row — a thin normalization of the repos the installation can access (GET /installation/repositories).
export interface InstallationRepo {
  fullName: string; // "owner/name"
  host?: string; // GHE base URL of the installation this repo belongs to — absent = github.com
  private: boolean;
  defaultBranch: string;
  pushedAt?: string;
}

// installation in the status view — bundles the repos GitHub allows this install (the ones chosen at install time).
// repos lookup is per-install soft-fail: one install's credential/network problem does not kill the other installs or the screen.
export type InstallationWithRepos = Installation & { repos?: InstallationRepo[]; reposError?: string };
export interface GithubAppDetailView {
  installations: InstallationWithRepos[];
  providers: GithubAppProviders;
}

export interface StartInstallInput {
  workspace: string;
  createdBy: string;
  host?: string; // absent = github.com (env App), set = the enterprise host (env App)
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// GHE base URL equality — ignores case/trailing-slash differences. undefined = github.com.
function sameHost(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return trimSlash(a).toLowerCase() === trimSlash(b).toLowerCase();
}

// git URL → { host?, owner, repo }. github.com omits host (= env App); anything else is treated as a GHE base.
function parseGitRepo(gitUrl: string): { host?: string; owner: string; repo: string } | undefined {
  let u: URL;
  try {
    u = new URL(gitUrl);
  } catch {
    return undefined;
  }
  const parts = u.pathname
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return undefined;
  const host = u.hostname === "github.com" ? undefined : `${u.protocol}//${u.host}`;
  return host ? { host, owner, repo } : { owner, repo };
}

export interface GithubAppServiceDeps {
  states: OAuthStateStore;
  settings: WorkspaceSettingsStore;
  gateway: GithubAppGateway;
  config: GithubAppServiceConfig;
  now?: () => Date;
}

export class GithubAppService {
  private readonly states: OAuthStateStore;
  private readonly settings: WorkspaceSettingsStore;
  private readonly gateway: GithubAppGateway;
  private readonly config: GithubAppServiceConfig;
  private readonly now: () => Date;
  constructor(deps: GithubAppServiceDeps) {
    this.states = deps.states;
    this.settings = deps.settings;
    this.gateway = deps.gateway;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
  }

  // Which App install targets the operator configured via env (github.com and/or the enterprise host).
  private providers(): GithubAppProviders {
    const e = this.config.githubEnterprise;
    return {
      githubCom: this.config.githubCom !== undefined,
      ...(e ? { enterprise: { host: e.host } } : {}),
    };
  }

  // The env App (github.com or enterprise) that owns this host — undefined host = github.com. No match = undefined.
  private appFor(host?: string): GithubComAppConfig | GithubEnterpriseAppConfig | undefined {
    if (!host) return this.config.githubCom;
    const e = this.config.githubEnterprise;
    return e && sameHost(host, e.host) ? e : undefined;
  }

  // Workspace App integration status (installations + configured providers). No secret values.
  async list(workspace: string): Promise<GithubAppView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    return { installations: g?.installations ?? [], providers: this.providers() };
  }

  // Unlink an installation (admin). The actual uninstall is on GitHub's side — here we just forget the record (idempotent).
  async unlinkInstallation(workspace: string, installationId: number): Promise<GithubAppView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    if (!g) return { installations: [], providers: this.providers() };
    const installations = g.installations.filter((i) => i.installationId !== installationId);
    await this.write(workspace, { installations });
    return { installations, providers: this.providers() };
  }

  // Start install → GitHub App install-page URL (includes state). Admin clicks → picks repos on GitHub → callback.
  async startInstall(input: StartInstallInput): Promise<{ installUrl: string }> {
    const target = this.resolveInstallTarget(input.host);
    const state = generateOAuthState();
    const expiresAt = new Date(this.now().getTime() + (this.config.stateTtlSec ?? 600) * 1000).toISOString();
    await this.states.put(
      state,
      {
        workspace: input.workspace,
        provider: "github-app",
        createdBy: input.createdBy,
        ...(input.host ? { host: input.host } : {}),
      },
      expiresAt,
    );
    const u = new URL(`${target.webBase}${target.installPath}/${target.slug}/installations/new`);
    u.searchParams.set("state", state);
    return { installUrl: u.toString() };
  }

  // Install callback — installation_id + state → confirm the account, then record the installation on the workspace (upsert).
  // GitHub gives an installation_id regardless of setup_action (install|update) → always upsert.
  async callback(input: { installationId?: number; state?: string }): Promise<{ redirectTo: string }> {
    if (!input.state) return { redirectTo: this.errorRedirect(undefined, "missing_state") };
    const pending = await this.states.take(input.state); // single-use — expired/reused is null
    if (!pending) return { redirectTo: this.errorRedirect(undefined, "invalid_state") };
    if (input.installationId === undefined)
      return { redirectTo: this.errorRedirect(pending.workspace, "missing_installation") };
    try {
      const creds = this.resolveAppCreds(pending.host);
      const { account } = await this.gateway.installationAccount(creds, input.installationId, pending.host);
      const g = (await this.settings.get(pending.workspace))?.githubApp;
      const record: Installation = {
        installationId: input.installationId,
        account,
        connectedBy: pending.createdBy,
        connectedAt: this.now().toISOString(),
        ...(pending.host ? { host: pending.host } : {}),
      };
      const installations = [
        ...(g?.installations ?? []).filter((i) => i.installationId !== input.installationId),
        record,
      ];
      await this.write(pending.workspace, { installations });
      return { redirectTo: this.successRedirect(pending.workspace) };
    } catch {
      // Credential resolve / installation lookup failed — show the browser an error callout (never expose the raw error).
      return { redirectTo: this.errorRedirect(pending.workspace, "install_failed") };
    }
  }

  // The callback URL to register as the App Setup URL (shown to admins). apiPublicUrl first, else the request base.
  callbackUrl(requestBaseUrl?: string): string | undefined {
    const base = this.config.apiPublicUrl ?? requestBaseUrl;
    return base ? `${trimSlash(base)}/workspace/github-app/callback` : undefined;
  }

  // Private-repo clone token — if the git URL's owner matches a workspace installation account, mint via that App
  // a short-lived (~1h) installation token scoped to that repo (contents:read). No matching installation → undefined.
  // execute-case calls this at dispatch time; the returned token rides only as transient (CaseJob.repoToken), never stored.
  async tokenForRepo(workspace: string, gitUrl: string): Promise<string | undefined> {
    const parsed = parseGitRepo(gitUrl);
    if (!parsed) return undefined;
    const install = await this.installationForOwner(workspace, parsed.owner, parsed.host);
    if (!install) return undefined;
    return this.mintFor(install, { repositories: [parsed.repo], permissions: { contents: "read" } });
  }

  // The repos one installation can access (only the ones chosen at install time) — GET /installation/repositories.
  private async reposFor(install: Installation): Promise<InstallationRepo[]> {
    const token = await this.mintFor(install, {}); // no restriction → list every installed repo
    const repos = await this.gateway.listInstallationRepos(token, install.host);
    return repos.map((r) => ({
      fullName: r.fullName,
      ...(install.host ? { host: install.host } : {}), // a GHE repo carries host so picker/link preserve the host
      private: r.private,
      defaultBranch: r.defaultBranch,
      ...(r.pushedAt ? { pushedAt: r.pushedAt } : {}),
    }));
  }

  // picker — the repos the workspace installation(s) can access (replacing personal connections). Merges each
  // installation's GET /installation/repositories. Only the repos chosen at install time appear (= only what the team explicitly allowed).
  async listRepos(workspace: string): Promise<InstallationRepo[]> {
    const g = (await this.settings.get(workspace))?.githubApp;
    const out: InstallationRepo[] = [];
    for (const install of g?.installations ?? []) out.push(...(await this.reposFor(install)));
    return out;
  }

  // Install status + each install's allowed repos — the settings screen/agent sees "what is installed and which repos are allowed".
  // Repo lookup is per-install soft-fail (reposError): one install's credential/network problem does not kill the other installs or the screen.
  async viewWithRepos(workspace: string): Promise<GithubAppDetailView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    const installations: InstallationWithRepos[] = [];
    for (const install of g?.installations ?? []) {
      try {
        installations.push({ ...install, repos: await this.reposFor(install) });
      } catch {
        // Never leak a raw GitHub error to the screen — show only a "lookup failed" state (the install record itself is still visible).
        installations.push({ ...install, reposError: "Failed to load the repository list." });
      }
    }
    return { installations, providers: this.providers() };
  }

  // installation token (specified permissions) + host for an "owner/name" repo. For write work like setup-PR (e.g. contents/pull_requests write).
  // No matching installation → NotFound (unlike a personal connection, the workspace must have the App installed on that org).
  // host absent = github.com — picks the exact installation even if the same org name exists on both github.com/GHE.
  async tokenForRepository(
    workspace: string,
    repository: string,
    permissions: Record<string, string>,
    host?: string,
  ): Promise<{ token: string; host?: string }> {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo)
      throw new BadRequestError("BAD_REQUEST", { repository }, `repository must be in "owner/name" form.`);
    const install = await this.installationForOwner(workspace, owner, host);
    if (!install)
      throw new NotFoundError(
        "NOT_FOUND",
        { repository, ...(host ? { host } : {}) },
        `No workspace GitHub App is installed on '${repository}'${host ? `(${host})` : ""}.`,
      );
    const token = await this.mintFor(install, { repositories: [repo], permissions });
    return { token, ...(install.host ? { host: install.host } : {}) };
  }

  // GitHub Actions self-hosted runner registration token — mint against the target (repo|org) via the workspace App installation (administration:write).
  // Short-lived token (≈1h). Instead of a personal connection/admin:org scope, it's issued when the App is installed on that org/repo and has administration permission.
  async runnerRegistrationToken(
    workspace: string,
    target: { repo: string } | { org: string },
    host?: string,
  ): Promise<{ token: string; expiresAt: string; host?: string }> {
    const owner = "repo" in target ? (target.repo.split("/")[0] ?? "") : target.org;
    // host set = only that host's installation (host-strict — exactly the GHE install the web picker chose).
    // absent = github.com first, else any host (legacy — a GHE-only workspace works without host).
    const install =
      host !== undefined
        ? await this.installationForOwner(workspace, owner, host)
        : await this.anyHostInstallationForOwner(workspace, owner);
    if (!install)
      throw new NotFoundError(
        "NOT_FOUND",
        { owner, ...(host !== undefined ? { host } : {}) },
        `No workspace GitHub App is installed on '${owner}'${host !== undefined ? `(${host})` : ""}.`,
      );
    const appToken = await this.mintFor(install, { permissions: { administration: "write" } });
    const data = await this.gateway.runnerRegistrationToken(appToken, target, install.host);
    return { token: data.token, expiresAt: data.expiresAt, ...(install.host ? { host: install.host } : {}) };
  }

  // Find the workspace installation by (owner, host). host absent = github.com — even if the same org name is
  // installed on both github.com and a GHE, it never mints a token via an installation on a different host.
  private async installationForOwner(
    workspace: string,
    owner: string,
    host?: string,
  ): Promise<Installation | undefined> {
    const g = (await this.settings.get(workspace))?.githubApp;
    return g?.installations.find((i) => i.account.toLowerCase() === owner.toLowerCase() && sameHost(i.host, host));
  }

  // Owner match when no host is given — prefer the github.com installation (removes ambiguity when the same owner is also on a GHE),
  // else any host (legacy — a GHE-only workspace works without host).
  private async anyHostInstallationForOwner(workspace: string, owner: string): Promise<Installation | undefined> {
    const g = (await this.settings.get(workspace))?.githubApp;
    const mine = g?.installations.filter((i) => i.account.toLowerCase() === owner.toLowerCase()) ?? [];
    return mine.find((i) => sameHost(i.host, undefined)) ?? mine[0];
  }

  // Mint an installation token for one installation (narrowed by repositories/permissions). Credentials from the env App for its host.
  private async mintFor(
    install: Installation,
    opts: { repositories?: string[]; permissions?: Record<string, string> },
  ): Promise<string> {
    const creds = this.resolveAppCreds(install.host);
    const tok = await this.gateway.mintInstallationToken(creds, install.installationId, opts, install.host);
    return tok.token;
  }

  private nowSec(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  private async write(workspace: string, githubApp: GithubAppSettings): Promise<void> {
    // settings.set is a top-level shallow merge → write the whole githubApp (installations) together.
    await this.settings.set(workspace, { githubApp });
  }

  // The install-page target for a host — github.com (env) or the enterprise host (env). No env App for the host = BadRequest.
  private resolveInstallTarget(host?: string): { slug: string; webBase: string; installPath: string } {
    if (!host) {
      const gc = this.config.githubCom;
      if (!gc) throw new BadRequestError("BAD_REQUEST", {}, "github.com App is not configured (GITHUB_APP_* env).");
      return { slug: gc.slug, webBase: "https://github.com", installPath: "/apps" };
    }
    const e = this.config.githubEnterprise;
    if (e && sameHost(host, e.host)) return { slug: e.slug, webBase: trimSlash(e.host), installPath: "/github-apps" };
    throw new BadRequestError(
      "BAD_REQUEST",
      { host },
      `GitHub Enterprise App is not configured for host: ${host} (GITHUB_ENTERPRISE_APP_* env).`,
    );
  }

  // Resolve App credentials (appId + private key) + the App-JWT clock (nowSec) for the gateway. github.com/enterprise both = env.
  private resolveAppCreds(host?: string): { appId: string; privateKeyPem: string; nowSec: number } {
    const nowSec = this.nowSec();
    const app = this.appFor(host);
    if (!app)
      throw new BadRequestError(
        "BAD_REQUEST",
        { ...(host ? { host } : {}) },
        host
          ? `GitHub Enterprise App is not configured for host: ${host} (GITHUB_ENTERPRISE_APP_* env).`
          : "github.com App is not configured (GITHUB_APP_* env).",
      );
    return { appId: app.appId, privateKeyPem: app.privateKeyPem, nowSec };
  }

  private settingsUrl(workspace: string): string {
    return `${trimSlash(this.config.webBaseUrl)}/${encodeURIComponent(workspace)}/settings?tab=integrations`;
  }
  private successRedirect(workspace: string): string {
    return `${this.settingsUrl(workspace)}&githubApp=installed`;
  }
  private errorRedirect(workspace: string | undefined, reason: string): string {
    if (workspace === undefined) return `${trimSlash(this.config.webBaseUrl)}/?error=${encodeURIComponent(reason)}`;
    return `${this.settingsUrl(workspace)}&error=${encodeURIComponent(reason)}`;
  }
}
