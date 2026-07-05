import { generateKeyPairSync } from "node:crypto";
import { BadRequestError, NotFoundError } from "@assay/core";
import { InMemoryOAuthStateStore, InMemoryWorkspaceSettingsStore } from "@assay/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubAppService } from "./github-app-service.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const NOW = new Date("2026-07-05T00:00:00Z");

afterEach(() => vi.unstubAllGlobals());

// GET /app/installations/{id} 응답만 스텁(설치 account 확정).
function stubInstallation(login: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ id: 1, account: { login } }), { status: 200 })),
  );
}

// installation 조회 + access token 발급을 URL 로 분기 스텁(tokenForRepo 용).
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

// App 능력용 종합 스텁 — access_tokens / installation 조회 / installation repos / 러너 등록토큰을 URL 로 분기.
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
        githubCom: { appId: "111", privateKeyPem: privateKey, slug: "assay-eval" },
      },
      now: () => NOW,
    });
  });

  it("github.com 설치 시작은 /apps/{slug}/installations/new URL + state 를 만든다", async () => {
    const { installUrl } = await svc.startInstall({ workspace: "acme", createdBy: "u-admin" });
    const u = new URL(installUrl);
    expect(u.origin + u.pathname).toBe("https://github.com/apps/assay-eval/installations/new");
    expect(u.searchParams.get("state")).toBeTruthy();
  });

  it("등록 안 된 GHE host 로 설치 시작하면 BadRequestError", async () => {
    await expect(
      svc.startInstall({ workspace: "acme", createdBy: "u", host: "https://ghe.acme.io" }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("GHE App 등록 후 설치 시작은 {host}/github-apps/{slug}/installations/new URL", async () => {
    await svc.registerGheApp("acme", {
      host: "https://ghe.acme.io",
      slug: "assay-ghe",
      appId: "222",
      privateKeySecretName: "ghe-app-key",
    });
    const { installUrl } = await svc.startInstall({ workspace: "acme", createdBy: "u", host: "https://ghe.acme.io" });
    expect(new URL(installUrl).origin + new URL(installUrl).pathname).toBe(
      "https://ghe.acme.io/github-apps/assay-ghe/installations/new",
    );
  });

  it("콜백은 installation_id+state → account 확정 후 워크스페이스에 설치를 기록한다", async () => {
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

  it("잘못된/만료 state 콜백은 에러 리다이렉트(설치 기록 안 함)", async () => {
    const { redirectTo } = await svc.callback({ installationId: 42, state: "nope" });
    expect(redirectTo).toContain("error=invalid_state");
    expect((await svc.list("acme")).installations).toEqual([]);
  });

  it("GHE 콜백은 SecretStore 의 App 개인키로 account 를 확정한다", async () => {
    stubInstallation("ghe-team");
    secrets.acme = { "ghe-app-key": privateKey };
    await svc.registerGheApp("acme", {
      host: "https://ghe.acme.io",
      slug: "assay-ghe",
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

  it("installation 링크 해제는 멱등하게 레코드를 지운다", async () => {
    stubInstallation("acme-org");
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put("st-2", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
    await svc.callback({ installationId: 42, state: "st-2" });

    const after = await svc.unlinkInstallation("acme", 42);
    expect(after.installations).toEqual([]);
    expect((await svc.unlinkInstallation("acme", 42)).installations).toEqual([]); // 멱등
  });

  it("tokenForRepo: git URL owner 가 워크스페이스 installation 과 매칭되면 그 repo 스코프 토큰을 발급한다", async () => {
    stubGithub("acme-org", "ghs_repo");
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put("st-t", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
    await svc.callback({ installationId: 42, state: "st-t" }); // account=acme-org 로 설치 기록

    const tok = await svc.tokenForRepo("acme", "https://github.com/acme-org/api.git");
    expect(tok).toBe("ghs_repo");
  });

  it("tokenForRepo: 매칭 installation 이 없으면 undefined(폴백은 호출부 몫)", async () => {
    stubGithub("acme-org", "ghs_repo");
    expect(await svc.tokenForRepo("acme", "https://github.com/other-org/api")).toBeUndefined();
  });

  // App 능력(S6a) — 개인 연결 대체: picker / 쓰기 토큰 / 러너 등록 토큰.
  async function installOrg(): Promise<void> {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put("st-x", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
    await svc.callback({ installationId: 42, state: "st-x" }); // account=acme-org 설치
  }

  it("listRepos 는 installation 이 접근 가능한 repo 를 정규화해 돌려준다(설치 시 고른 것만)", async () => {
    stubApi(["acme-org/api", "acme-org/web"]);
    await installOrg();
    const repos = await svc.listRepos("acme");
    expect(repos.map((r) => r.fullName)).toEqual(["acme-org/api", "acme-org/web"]);
    expect(repos[0]).toMatchObject({ private: true, defaultBranch: "main" });
  });

  it("tokenForRepository 는 지정 권한으로 그 repo 의 installation 토큰을 발급한다", async () => {
    stubApi([]);
    await installOrg();
    const out = await svc.tokenForRepository("acme", "acme-org/api", {
      contents: "write",
      pull_requests: "write",
    });
    expect(out.token).toBe("ghs_inst");
  });

  it("tokenForRepository 는 매칭 installation 이 없으면 NotFound", async () => {
    stubApi([]);
    await installOrg();
    await expect(svc.tokenForRepository("acme", "other-org/api", {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it("runnerRegistrationToken 는 App(administration)으로 러너 등록 토큰을 발급한다", async () => {
    stubApi([]);
    await installOrg();
    const out = await svc.runnerRegistrationToken("acme", { org: "acme-org" });
    expect(out.token).toBe("RUNNERTOK");
  });
});
