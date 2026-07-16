import { generateKeyPairSync } from "node:crypto";
import { GithubAppService } from "@everdict/application-control";
import { BadRequestError, NotFoundError } from "@everdict/contracts";
import { InMemoryOAuthStateStore, InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubAppGateway } from "../../infrastructure/github/app-gateway.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const NOW = new Date("2026-07-05T00:00:00Z");
// The operator env GitHub Enterprise App — one App per host for the whole deployment (handled identically to github.com).
const ENTERPRISE_HOST = "https://ghe.acme.io";

afterEach(() => vi.unstubAllGlobals());

// Stub only the GET /app/installations/{id} response (confirm the install account).
function stubInstallation(login: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ id: 1, account: { login } }), { status: 200 })),
  );
}

// Branch by URL to stub installation lookup + access-token minting (for tokenForRepo).
function stubGithub(login: string, token: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const body = String(url).endsWith("/access_tokens")
        ? { token, expires_at: "2026-07-05T12:00:00Z" }
        : { id: 1, account: { login } };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

// Composite stub for App capabilities — branch by URL over access_tokens / installation lookup / installation repos / runner registration token.
function stubApi(repos: string[], runnerTok = "RUNNERTOK"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const s = String(url);
      const body = s.endsWith("/access_tokens")
        ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
        : s.includes("/installation/repositories")
          ? {
              repositories: repos.map((r) => ({
                full_name: r,
                private: true,
                default_branch: "main",
                pushed_at: "2026-07-01T00:00:00Z",
              })),
            }
          : s.endsWith("/registration-token")
            ? { token: runnerTok, expires_at: "2026-07-05T12:00:00Z" }
            : { id: 1, account: { login: "acme-org" } }; // getInstallation
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe("GithubAppService", () => {
  let states: InMemoryOAuthStateStore;
  let settings: InMemoryWorkspaceSettingsStore;
  let svc: GithubAppService;

  beforeEach(() => {
    states = new InMemoryOAuthStateStore(() => NOW.toISOString());
    settings = new InMemoryWorkspaceSettingsStore();
    svc = new GithubAppService({
      states,
      settings,
      gateway: githubAppGateway(), // fake fetch (vi.stubGlobal) routes through the real adapter → wire assertions survive
      config: {
        webBaseUrl: "http://web.test",
        apiPublicUrl: "http://api.test",
        // Both providers are operator env — one App per host, install-only (no per-workspace App registration).
        githubCom: { appId: "111", privateKeyPem: privateKey, slug: "everdict-eval" },
        githubEnterprise: { host: ENTERPRISE_HOST, appId: "222", privateKeyPem: privateKey, slug: "everdict-ghe" },
      },
      now: () => NOW,
    });
  });

  it("list reports the configured providers (github.com + enterprise, both operator env) with no per-workspace registrations", async () => {
    const view = await svc.list("acme");
    expect(view.providers).toEqual({ githubCom: true, enterprise: { host: ENTERPRISE_HOST } });
    expect(view.installations).toEqual([]);
  });

  it("starting a github.com install makes a /apps/{slug}/installations/new URL + state", async () => {
    const { installUrl } = await svc.startInstall({ workspace: "acme", createdBy: "u-admin" });
    const u = new URL(installUrl);
    expect(u.origin + u.pathname).toBe("https://github.com/apps/everdict-eval/installations/new");
    expect(u.searchParams.get("state")).toBeTruthy();
  });

  it("starting an enterprise install (the operator env host) → {host}/github-apps/{slug}/installations/new URL", async () => {
    const { installUrl } = await svc.startInstall({ workspace: "acme", createdBy: "u", host: ENTERPRISE_HOST });
    expect(new URL(installUrl).origin + new URL(installUrl).pathname).toBe(
      "https://ghe.acme.io/github-apps/everdict-ghe/installations/new",
    );
  });

  it("starting an install for a host that isn't the configured enterprise host → BadRequestError", async () => {
    await expect(
      svc.startInstall({ workspace: "acme", createdBy: "u", host: "https://other-ghe.example.com" }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("the enterprise host is matched with normalized equality — trailing-slash/case differences still resolve the install URL", async () => {
    const { installUrl } = await svc.startInstall({ workspace: "acme", createdBy: "u", host: "https://GHE.Acme.io/" });
    // The install URL uses the configured host form (not the caller's notation).
    expect(installUrl).toContain("https://ghe.acme.io/github-apps/everdict-ghe/installations/new");
  });

  it("the callback: installation_id+state → confirm account, then record the install on the workspace", async () => {
    stubInstallation("acme-org");
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put("st-1", { workspace: "acme", provider: "github-app", createdBy: "u-admin" }, future);

    const { redirectTo } = await svc.callback({ installationId: 42, state: "st-1" });
    expect(redirectTo).toContain("/acme/settings?tab=integrations");
    expect(redirectTo).toContain("githubApp=installed");

    const view = await svc.list("acme");
    expect(view.installations).toEqual([
      { installationId: 42, account: "acme-org", connectedBy: "u-admin", connectedAt: NOW.toISOString() },
    ]);
  });

  it("a bad/expired state callback → error redirect (no install recorded)", async () => {
    const { redirectTo } = await svc.callback({ installationId: 42, state: "nope" });
    expect(redirectTo).toContain("error=invalid_state");
    expect((await svc.list("acme")).installations).toEqual([]);
  });

  it("an enterprise callback confirms the account with the operator env enterprise App creds (no SecretStore)", async () => {
    stubInstallation("ghe-team");
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put(
      "st-ghe",
      { workspace: "acme", provider: "github-app", createdBy: "u", host: ENTERPRISE_HOST },
      future,
    );

    await svc.callback({ installationId: 7, state: "st-ghe" });
    const view = await svc.list("acme");
    expect(view.installations[0]).toMatchObject({ installationId: 7, account: "ghe-team", host: ENTERPRISE_HOST });
  });

  it("unlinking an installation removes the record idempotently", async () => {
    stubInstallation("acme-org");
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put("st-2", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
    await svc.callback({ installationId: 42, state: "st-2" });

    const after = await svc.unlinkInstallation("acme", 42);
    expect(after.installations).toEqual([]);
    expect((await svc.unlinkInstallation("acme", 42)).installations).toEqual([]); // idempotent
  });

  it("tokenForRepo: when the git URL owner matches a workspace installation, mints a repo-scoped token", async () => {
    stubGithub("acme-org", "ghs_repo");
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put("st-t", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
    await svc.callback({ installationId: 42, state: "st-t" }); // records install with account=acme-org

    const tok = await svc.tokenForRepo("acme", "https://github.com/acme-org/api.git");
    expect(tok).toBe("ghs_repo");
  });

  it("tokenForRepo: no matching installation → undefined (fallback is the caller's job)", async () => {
    stubGithub("acme-org", "ghs_repo");
    expect(await svc.tokenForRepo("acme", "https://github.com/other-org/api")).toBeUndefined();
  });

  // App capabilities — replacing personal connections: picker / write token / runner registration token.
  async function installOrg(): Promise<void> {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put("st-x", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
    await svc.callback({ installationId: 42, state: "st-x" }); // install with account=acme-org
  }

  it("listRepos normalizes and returns the repos the installation can access (only the ones chosen at install time)", async () => {
    stubApi(["acme-org/api", "acme-org/web"]);
    await installOrg();
    const repos = await svc.listRepos("acme");
    expect(repos.map((r) => r.fullName)).toEqual(["acme-org/api", "acme-org/web"]);
    expect(repos[0]).toMatchObject({ private: true, defaultBranch: "main" });
  });

  it("tokenForRepository mints that repo's installation token with the specified permissions", async () => {
    stubApi([]);
    await installOrg();
    const out = await svc.tokenForRepository("acme", "acme-org/api", {
      contents: "write",
      pull_requests: "write",
    });
    expect(out.token).toBe("ghs_inst");
  });

  it("tokenForRepository → NotFound when there is no matching installation", async () => {
    stubApi([]);
    await installOrg();
    await expect(svc.tokenForRepository("acme", "other-org/api", {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it("runnerRegistrationToken mints a runner registration token via the App (administration)", async () => {
    stubApi([]);
    await installOrg();
    const out = await svc.runnerRegistrationToken("acme", { org: "acme-org" });
    expect(out.token).toBe("RUNNERTOK");
  });

  // Enterprise host threading — even if the same org name is on both github.com/GHE, picks the exact installation by host.
  describe("enterprise host threading", () => {
    // stubApi + record the call URLs (observe which host's installation minted the token).
    function stubApiRecording(repos: string[]): string[] {
      const urls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          const s = String(url);
          urls.push(s);
          const body = s.endsWith("/access_tokens")
            ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
            : s.includes("/installation/repositories")
              ? {
                  repositories: repos.map((r) => ({
                    full_name: r,
                    private: true,
                    default_branch: "main",
                    pushed_at: "2026-07-01T00:00:00Z",
                  })),
                }
              : s.endsWith("/registration-token")
                ? { token: "RUNNERTOK", expires_at: "2026-07-05T12:00:00Z" }
                : { id: 1, account: { login: "acme-org" } };
          return new Response(JSON.stringify(body), { status: 200 });
        }),
      );
      return urls;
    }

    // Install both github.com (id 42) + enterprise (id 7, same account) — the ambiguity scenario. Both creds are operator env.
    async function installBothHosts(): Promise<void> {
      const future = new Date(NOW.getTime() + 60_000).toISOString();
      await states.put("st-com", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
      await svc.callback({ installationId: 42, state: "st-com" });
      await states.put(
        "st-ghe2",
        { workspace: "acme", provider: "github-app", createdBy: "u", host: ENTERPRISE_HOST },
        future,
      );
      await svc.callback({ installationId: 7, state: "st-ghe2" });
    }

    it("listRepos carries host on the enterprise installation's repos (github.com is unmarked)", async () => {
      stubApiRecording([]);
      await installBothHosts();
      stubApiRecording(["acme-org/api"]);
      const repos = await svc.listRepos("acme");
      expect(repos).toHaveLength(2); // one from each of the two installations
      expect(repos.find((r) => r.host === undefined)?.fullName).toBe("acme-org/api");
      expect(repos.find((r) => r.host === ENTERPRISE_HOST)?.fullName).toBe("acme-org/api");
    });

    it("tokenForRepository picks the installation by host — enterprise (id 7) when the enterprise host is given, github.com (id 42) when absent", async () => {
      stubApiRecording([]);
      await installBothHosts();

      let urls = stubApiRecording([]);
      const ghe = await svc.tokenForRepository("acme", "acme-org/api", {}, ENTERPRISE_HOST);
      expect(ghe.host).toBe(ENTERPRISE_HOST);
      expect(urls.some((u) => u.startsWith("https://ghe.acme.io/api/v3/app/installations/7/access_tokens"))).toBe(true);

      urls = stubApiRecording([]);
      const com = await svc.tokenForRepository("acme", "acme-org/api", {});
      expect(com.host).toBeUndefined();
      expect(urls.some((u) => u.startsWith("https://api.github.com/app/installations/42/access_tokens"))).toBe(true);
    });

    it("runnerRegistrationToken picks the installation by host — enterprise (id 7) when a host is given, github.com (id 42) preferred when unset", async () => {
      stubApiRecording([]);
      await installBothHosts();

      // host given → mint only from that enterprise installation (host-strict).
      let urls = stubApiRecording([]);
      const ghe = await svc.runnerRegistrationToken("acme", { org: "acme-org" }, ENTERPRISE_HOST);
      expect(ghe.host).toBe(ENTERPRISE_HOST);
      expect(urls.some((u) => u.startsWith("https://ghe.acme.io/api/v3/app/installations/7/access_tokens"))).toBe(true);
      expect(urls.some((u) => u.includes("/orgs/acme-org/actions/runners/registration-token"))).toBe(true);

      // host unset → github.com installation wins even when the same owner is on both (removes ambiguity).
      urls = stubApiRecording([]);
      const com = await svc.runnerRegistrationToken("acme", { org: "acme-org" });
      expect(com.host).toBeUndefined();
      expect(urls.some((u) => u.startsWith("https://api.github.com/app/installations/42/access_tokens"))).toBe(true);
    });

    it("runnerRegistrationToken is NotFound when the given host has no installation (won't fall back to mint from another host)", async () => {
      stubApiRecording([]);
      await installBothHosts();
      await expect(
        svc.runnerRegistrationToken("acme", { org: "acme-org" }, "https://other.example.com"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("viewWithRepos bundles the allowed repos into each installation and soft-fails only the failed installation with reposError", async () => {
      stubApiRecording([]);
      await installBothHosts(); // github.com(42) + enterprise(7) — both account=acme-org
      // Enterprise installation's repo lookup fails (500) → only that entry gets reposError; github.com stays fine.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          const s = String(url);
          if (s.startsWith("https://ghe.acme.io") && s.includes("/installation/repositories"))
            return new Response("upstream boom", { status: 500 });
          const body = s.endsWith("/access_tokens")
            ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
            : s.includes("/installation/repositories")
              ? {
                  repositories: [
                    {
                      full_name: "acme-org/api",
                      private: true,
                      default_branch: "main",
                      pushed_at: "2026-07-01T00:00:00Z",
                    },
                  ],
                }
              : { id: 1, account: { login: "acme-org" } };
          return new Response(JSON.stringify(body), { status: 200 });
        }),
      );
      const view = await svc.viewWithRepos("acme");
      const com = view.installations.find((i) => i.host === undefined);
      const ghe = view.installations.find((i) => i.host === ENTERPRISE_HOST);
      expect(com?.repos?.map((r) => r.fullName)).toEqual(["acme-org/api"]);
      expect(com?.reposError).toBeUndefined();
      expect(ghe?.repos).toBeUndefined();
      expect(ghe?.reposError).toBeTruthy(); // a human-readable status only, not a raw GitHub/credential error
    });

    it("tokenForRepo regression: an enterprise git URL does not mint a token from a github.com installation (host-strict)", async () => {
      stubGithub("acme-org", "ghs_repo");
      const future = new Date(NOW.getTime() + 60_000).toISOString();
      await states.put("st-y", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
      await svc.callback({ installationId: 42, state: "st-y" }); // only the github.com installation exists
      expect(await svc.tokenForRepo("acme", "https://ghe.acme.io/acme-org/api.git")).toBeUndefined();
    });
  });
});
