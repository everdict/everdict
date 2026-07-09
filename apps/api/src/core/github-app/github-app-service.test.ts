import { generateKeyPairSync } from "node:crypto";
import { BadRequestError, NotFoundError } from "@everdict/core";
import { InMemoryOAuthStateStore, InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubAppService } from "./github-app-service.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const NOW = new Date("2026-07-05T00:00:00Z");

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
  let secrets: Record<string, Record<string, string>>;
  let svc: GithubAppService;

  beforeEach(() => {
    states = new InMemoryOAuthStateStore(() => NOW.toISOString());
    settings = new InMemoryWorkspaceSettingsStore();
    secrets = {};
    svc = new GithubAppService({
      states,
      settings,
      secretsFor: async (ws) => secrets[ws] ?? {},
      config: {
        webBaseUrl: "http://web.test",
        apiPublicUrl: "http://api.test",
        githubCom: { appId: "111", privateKeyPem: privateKey, slug: "everdict-eval" },
      },
      now: () => NOW,
    });
  });

  it("starting a github.com install makes a /apps/{slug}/installations/new URL + state", async () => {
    const { installUrl } = await svc.startInstall({ workspace: "acme", createdBy: "u-admin" });
    const u = new URL(installUrl);
    expect(u.origin + u.pathname).toBe("https://github.com/apps/everdict-eval/installations/new");
    expect(u.searchParams.get("state")).toBeTruthy();
  });

  it("starting an install for an unregistered GHE host → BadRequestError", async () => {
    await expect(
      svc.startInstall({ workspace: "acme", createdBy: "u", host: "https://ghe.acme.io" }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("after registering a GHE App, starting an install → {host}/github-apps/{slug}/installations/new URL", async () => {
    await svc.registerGheApp("acme", {
      host: "https://ghe.acme.io",
      slug: "everdict-ghe",
      appId: "222",
      privateKeySecretName: "ghe-app-key",
    });
    const { installUrl } = await svc.startInstall({ workspace: "acme", createdBy: "u", host: "https://ghe.acme.io" });
    expect(new URL(installUrl).origin + new URL(installUrl).pathname).toBe(
      "https://ghe.acme.io/github-apps/everdict-ghe/installations/new",
    );
  });

  it("GHE host uses normalized equality — a re-registration differing only in trailing slash/case is an upsert (no duplicate row), and unlink/install URLs treat it the same", async () => {
    // Given: registered with a trailing-slash host.
    await svc.registerGheApp("acme", {
      host: "https://ghe.acme.io/",
      slug: "app-v1",
      appId: "111",
      privateKeySecretName: "k1",
    });
    // When: re-registered without the slash + mixed case — it's the same server.
    await svc.registerGheApp("acme", {
      host: "https://GHE.Acme.io",
      slug: "app-v2",
      appId: "222",
      privateKeySecretName: "k2",
    });
    // Then: not a duplicate row but a single updated record (before the fix, a string mismatch made it 2 — the root of the 'not installed' misread).
    const view = await svc.list("acme");
    expect(view.registrations).toHaveLength(1);
    expect(view.registrations[0]?.slug).toBe("app-v2");
    // Install URL resolution also passes despite the differing notation.
    const { installUrl } = await svc.startInstall({ workspace: "acme", createdBy: "u", host: "https://ghe.acme.io/" });
    expect(installUrl).toContain("/github-apps/app-v2/");
    // Unlink also removes it despite the differing notation.
    await svc.removeRegistration("acme", "HTTPS://ghe.acme.io");
    expect((await svc.list("acme")).registrations).toEqual([]);
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

  it("a GHE callback confirms the account with the App private key from SecretStore", async () => {
    stubInstallation("ghe-team");
    secrets.acme = { "ghe-app-key": privateKey };
    await svc.registerGheApp("acme", {
      host: "https://ghe.acme.io",
      slug: "everdict-ghe",
      appId: "222",
      privateKeySecretName: "ghe-app-key",
    });
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put(
      "st-ghe",
      { workspace: "acme", provider: "github-app", createdBy: "u", host: "https://ghe.acme.io" },
      future,
    );

    await svc.callback({ installationId: 7, state: "st-ghe" });
    const view = await svc.list("acme");
    expect(view.installations[0]).toMatchObject({
      installationId: 7,
      account: "ghe-team",
      host: "https://ghe.acme.io",
    });
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

  // App capabilities (S6a) — replacing personal connections: picker / write token / runner registration token.
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

  // GHE host threading — even if the same org name is on both github.com/GHE, picks the exact installation by host.
  describe("GHE host threading", () => {
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

    // Install both github.com (id 42) + GHE (id 7, same account) — the ambiguity scenario.
    async function installBothHosts(): Promise<void> {
      secrets.acme = { "ghe-app-key": privateKey };
      await svc.registerGheApp("acme", {
        host: "https://ghe.acme.io",
        slug: "everdict-ghe",
        appId: "222",
        privateKeySecretName: "ghe-app-key",
      });
      const future = new Date(NOW.getTime() + 60_000).toISOString();
      await states.put("st-com", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
      await svc.callback({ installationId: 42, state: "st-com" });
      await states.put(
        "st-ghe2",
        { workspace: "acme", provider: "github-app", createdBy: "u", host: "https://ghe.acme.io" },
        future,
      );
      await svc.callback({ installationId: 7, state: "st-ghe2" });
    }

    it("listRepos carries host on the GHE installation's repos (github.com is unmarked)", async () => {
      stubApiRecording([]);
      await installBothHosts();
      stubApiRecording(["acme-org/api"]);
      const repos = await svc.listRepos("acme");
      expect(repos).toHaveLength(2); // one from each of the two installations
      expect(repos.find((r) => r.host === undefined)?.fullName).toBe("acme-org/api");
      expect(repos.find((r) => r.host === "https://ghe.acme.io")?.fullName).toBe("acme-org/api");
    });

    it("tokenForRepository picks the installation by host — GHE (id 7) when the GHE host is given, github.com (id 42) when absent", async () => {
      stubApiRecording([]);
      await installBothHosts();

      let urls = stubApiRecording([]);
      const ghe = await svc.tokenForRepository("acme", "acme-org/api", {}, "https://ghe.acme.io");
      expect(ghe.host).toBe("https://ghe.acme.io");
      expect(urls.some((u) => u.startsWith("https://ghe.acme.io/api/v3/app/installations/7/access_tokens"))).toBe(true);

      urls = stubApiRecording([]);
      const com = await svc.tokenForRepository("acme", "acme-org/api", {});
      expect(com.host).toBeUndefined();
      expect(urls.some((u) => u.startsWith("https://api.github.com/app/installations/42/access_tokens"))).toBe(true);
    });

    it("runnerRegistrationToken picks the installation by host — GHE (id 7) when a GHE host is given, github.com (id 42) preferred when unset", async () => {
      stubApiRecording([]);
      await installBothHosts();

      // host given → mint only from that GHE installation (host-strict).
      let urls = stubApiRecording([]);
      const ghe = await svc.runnerRegistrationToken("acme", { org: "acme-org" }, "https://ghe.acme.io");
      expect(ghe.host).toBe("https://ghe.acme.io");
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
      await installBothHosts(); // github.com(42) + GHE(7) — both account=acme-org
      stubApiRecording(["acme-org/api"]);
      secrets.acme = {}; // GHE App private key lost → only the GHE installation's repo lookup should fail
      const view = await svc.viewWithRepos("acme");
      const com = view.installations.find((i) => i.host === undefined);
      const ghe = view.installations.find((i) => i.host === "https://ghe.acme.io");
      expect(com?.repos?.map((r) => r.fullName)).toEqual(["acme-org/api"]);
      expect(com?.reposError).toBeUndefined();
      expect(ghe?.repos).toBeUndefined();
      expect(ghe?.reposError).toBeTruthy(); // a human-readable status only, not a raw GitHub/credential error
    });

    it("tokenForRepo regression: a GHE git URL does not mint a token from a github.com installation (host-strict)", async () => {
      stubGithub("acme-org", "ghs_repo");
      const future = new Date(NOW.getTime() + 60_000).toISOString();
      await states.put("st-y", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
      await svc.callback({ installationId: 42, state: "st-y" }); // only the github.com installation exists
      expect(await svc.tokenForRepo("acme", "https://ghe.acme.io/acme-org/api.git")).toBeUndefined();
    });
  });
});
