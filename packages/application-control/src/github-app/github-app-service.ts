import { randomBytes } from "node:crypto";
import { BadRequestError, NotFoundError, type WorkspaceSettings } from "@everdict/contracts";
import type { GithubAppGateway } from "../ports/github-app-gateway.js";
import type { OAuthStateStore } from "../ports/oauth-state-store.js";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// Workspace-owned GitHub App integration service — replaces personal Connected accounts (OAuth tokens).
// Org install → chosen repos → a workspace-owned installation. github.com App = operator env (config.githubCom);
// GHE App = admin registers it on the workspace with host+slug+appId+privateKeySecretName (private key = SecretStore name-ref).
// The HTTP route and the MCP tool share this core (BFF↔MCP parity). Private-key/token values never leave for the browser.
// This use-case owns the sameHost/installation-selection/upsert/state semantics + credential resolution; the GitHub REST
// protocol (URLs, App-JWT/token plumbing, headers, response parsing, error remapping) moved behind GithubAppGateway
// in re-architecture P2d. Design: docs/architecture/workspace-scoped-integrations.md

type GithubAppSettings = NonNullable<WorkspaceSettings["githubApp"]>;
type Registration = GithubAppSettings["registrations"][number];
type Installation = GithubAppSettings["installations"][number];

// An unguessable state nonce. Goes out as the authorize URL's state parameter and comes back as-is in the callback.
function generateOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

// Operator github.com App credentials (env). If unset, the github.com App is disabled (GHE is still available via workspace registration).
export interface GithubComAppConfig {
  appId: string;
  privateKeyPem: string;
  slug: string; // used in the install URL github.com/apps/{slug}/installations/new
}

export interface GithubAppServiceConfig {
  webBaseUrl: string; // web base the browser returns to after the callback (e.g. http://localhost:3001)
  apiPublicUrl?: string; // install-callback (App Setup URL) base. Falls back to the request base if unset.
  stateTtlSec?: number; // pending state expiry (default 600s)
  githubCom?: GithubComAppConfig; // env default github.com App (absent → github.com install disabled)
}

// A registration as served (re-architecture P1g): carries the accounts installed on its host
// (normalized sameHost match) so the web doesn't re-implement host normalization — the 748eecb
// production bug was exactly that mirror drifting.
export type ServedRegistration = Registration & { installedAccounts?: string[] };

// Workspace App integration status (no secrets — privateKeySecretName is a name reference, not a value, so it's safe to return).
export interface GithubAppView {
  registrations: ServedRegistration[];
  installations: Installation[];
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
  registrations: ServedRegistration[];
  installations: InstallationWithRepos[];
}

export interface StartInstallInput {
  workspace: string;
  createdBy: string;
  host?: string; // absent = github.com (env App), set = that GHE registration
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
  secretsFor: (workspace: string) => Promise<Record<string, string>>;
  gateway: GithubAppGateway;
  config: GithubAppServiceConfig;
  now?: () => Date;
}

export class GithubAppService {
  private readonly states: OAuthStateStore;
  private readonly settings: WorkspaceSettingsStore;
  private readonly secretsFor: (workspace: string) => Promise<Record<string, string>>;
  private readonly gateway: GithubAppGateway;
  private readonly config: GithubAppServiceConfig;
  private readonly now: () => Date;
  constructor(deps: GithubAppServiceDeps) {
    this.states = deps.states;
    this.settings = deps.settings;
    this.secretsFor = deps.secretsFor;
    this.gateway = deps.gateway;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
  }

  // Serve-time enrichment: each registration carries its host's installed accounts (sameHost is the
  // one normalization owner — the web reads the served field instead of re-comparing hosts).
  private serveRegistrations(registrations: Registration[], installations: Installation[]): ServedRegistration[] {
    return registrations.map((r) => {
      const accounts = installations.filter((i) => sameHost(i.host, r.host)).map((i) => i.account);
      return accounts.length > 0 ? { ...r, installedAccounts: accounts } : r;
    });
  }

  // Workspace App integration status (registrations + installations). No secret values.
  async list(workspace: string): Promise<GithubAppView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    const installations = g?.installations ?? [];
    return { registrations: this.serveRegistrations(g?.registrations ?? [], installations), installations };
  }

  // Register/update a GHE App (admin). Upsert by host. Put the private key into SecretStore first, then name it here.
  async registerGheApp(workspace: string, input: Registration): Promise<GithubAppView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    // Upsert host by normalized equality (sameHost) — prevents duplicate registrations differing only in trailing slash/case.
    const registrations = [...(g?.registrations ?? []).filter((r) => !sameHost(r.host, input.host)), input];
    await this.write(workspace, { registrations, installations: g?.installations ?? [] });
    const installations = g?.installations ?? [];
    return { registrations: this.serveRegistrations(registrations, installations), installations };
  }

  // Unregister a GHE App (admin). Existing installation records remain but cannot mint tokens without credentials.
  async removeRegistration(workspace: string, host: string): Promise<GithubAppView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    if (!g) return { registrations: [], installations: [] };
    const registrations = g.registrations.filter((r) => !sameHost(r.host, host));
    await this.write(workspace, { registrations, installations: g.installations });
    return { registrations: this.serveRegistrations(registrations, g.installations), installations: g.installations };
  }

  // Unlink an installation (admin). The actual uninstall is on GitHub's side — here we just forget the record (idempotent).
  async unlinkInstallation(workspace: string, installationId: number): Promise<GithubAppView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    if (!g) return { registrations: [], installations: [] };
    const installations = g.installations.filter((i) => i.installationId !== installationId);
    await this.write(workspace, { registrations: g.registrations, installations });
    return { registrations: this.serveRegistrations(g.registrations, installations), installations };
  }

  // Start install → GitHub App install-page URL (includes state). Admin clicks → picks repos on GitHub → callback.
  async startInstall(input: StartInstallInput): Promise<{ installUrl: string }> {
    const target = await this.resolveInstallTarget(input.workspace, input.host);
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
      const creds = await this.resolveAppCreds(pending.workspace, pending.host);
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
      await this.write(pending.workspace, { registrations: g?.registrations ?? [], installations });
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
  // execute-case calls this at dispatch time; the returned token rides only as transient (AgentJob.repoToken), never stored.
  async tokenForRepo(workspace: string, gitUrl: string): Promise<string | undefined> {
    const parsed = parseGitRepo(gitUrl);
    if (!parsed) return undefined;
    const install = await this.installationForOwner(workspace, parsed.owner, parsed.host);
    if (!install) return undefined;
    return this.mintFor(workspace, install, { repositories: [parsed.repo], permissions: { contents: "read" } });
  }

  // The repos one installation can access (only the ones chosen at install time) — GET /installation/repositories.
  private async reposFor(workspace: string, install: Installation): Promise<InstallationRepo[]> {
    const token = await this.mintFor(workspace, install, {}); // no restriction → list every installed repo
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
    for (const install of g?.installations ?? []) out.push(...(await this.reposFor(workspace, install)));
    return out;
  }

  // Install status + each install's allowed repos — the settings screen/agent sees "what is installed and which repos are allowed".
  // Repo lookup is per-install soft-fail (reposError): one install's credential/network problem does not kill the other installs or the screen.
  async viewWithRepos(workspace: string): Promise<GithubAppDetailView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    const installations: InstallationWithRepos[] = [];
    for (const install of g?.installations ?? []) {
      try {
        installations.push({ ...install, repos: await this.reposFor(workspace, install) });
      } catch {
        // Never leak a raw GitHub error to the screen — show only a "lookup failed" state (the install record itself is still visible).
        installations.push({ ...install, reposError: "Failed to load the repository list." });
      }
    }
    return { registrations: this.serveRegistrations(g?.registrations ?? [], g?.installations ?? []), installations };
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
    const token = await this.mintFor(workspace, install, { repositories: [repo], permissions });
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
    const appToken = await this.mintFor(workspace, install, { permissions: { administration: "write" } });
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

  // Mint an installation token for one installation (narrowed by repositories/permissions). Credentials from env (github.com) or the GHE registration.
  private async mintFor(
    workspace: string,
    install: Installation,
    opts: { repositories?: string[]; permissions?: Record<string, string> },
  ): Promise<string> {
    const creds = await this.resolveAppCreds(workspace, install.host);
    const tok = await this.gateway.mintInstallationToken(creds, install.installationId, opts, install.host);
    return tok.token;
  }

  private nowSec(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  private async write(workspace: string, githubApp: GithubAppSettings): Promise<void> {
    // settings.set is a top-level shallow merge → always write the whole githubApp (registrations + installations) together.
    await this.settings.set(workspace, { githubApp });
  }

  private async resolveInstallTarget(
    workspace: string,
    host?: string,
  ): Promise<{ slug: string; webBase: string; installPath: string }> {
    if (!host) {
      const gc = this.config.githubCom;
      if (!gc) throw new BadRequestError("BAD_REQUEST", {}, "github.com App is not configured (GITHUB_APP_* env).");
      return { slug: gc.slug, webBase: "https://github.com", installPath: "/apps" };
    }
    const reg = (await this.settings.get(workspace))?.githubApp?.registrations.find((r) => sameHost(r.host, host));
    if (!reg) throw new BadRequestError("BAD_REQUEST", { host }, `Unregistered GHE App host: ${host}`);
    return { slug: reg.slug, webBase: trimSlash(host), installPath: "/github-apps" };
  }

  // Resolve App credentials (appId + private key) + the App-JWT clock (nowSec) for the gateway. github.com = env; GHE = registration's SecretStore key.
  private async resolveAppCreds(
    workspace: string,
    host?: string,
  ): Promise<{ appId: string; privateKeyPem: string; nowSec: number }> {
    const nowSec = this.nowSec();
    if (!host) {
      const gc = this.config.githubCom;
      if (!gc) throw new BadRequestError("BAD_REQUEST", {}, "github.com App is not configured (GITHUB_APP_* env).");
      return { appId: gc.appId, privateKeyPem: gc.privateKeyPem, nowSec };
    }
    const reg = (await this.settings.get(workspace))?.githubApp?.registrations.find((r) => sameHost(r.host, host));
    if (!reg) throw new BadRequestError("BAD_REQUEST", { host }, `Unregistered GHE App host: ${host}`);
    const pem = (await this.secretsFor(workspace))[reg.privateKeySecretName];
    if (!pem)
      throw new BadRequestError(
        "BAD_REQUEST",
        { name: reg.privateKeySecretName },
        `App private key not found in SecretStore: ${reg.privateKeySecretName}`,
      );
    return { appId: reg.appId, privateKeyPem: pem, nowSec };
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
